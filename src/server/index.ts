import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import {
  assertSameOrigin,
  clientIp,
  ipAllowed,
  LoginLockout,
  parseIpAllowlist,
  requestIsHttps,
  securityHeaders,
  sessionCookie,
  turnstileRequired,
  turnstileSiteKey,
  verifyTurnstileToken,
} from "./httpSecurity";
import { IntakeMonitor } from "./IntakeMonitor";
import { Notifier } from "./Notifier";
import { Scheduler } from "./Scheduler";
import { SecretBox } from "./SecretBox";
import { openDatabase, Store, ValidationError } from "./Store";
import {
  configuredOpenwaBaseUrl,
  ensureOpenwaSession,
  OpenwaClient,
  readOpenwaSession,
  WhatsAppError,
} from "./whatsapp";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 100 * 1024;
const DEV =
  process.env.VISA_DEV === "1" || process.env.VISA_DEV === "true";
const VITE_ORIGIN = `http://127.0.0.1:${process.env.VITE_DEV_PORT || "5173"}`;
const ADMIN_IP_ALLOWLIST = parseIpAllowlist(process.env.ADMIN_IP_ALLOWLIST);

const PUBLIC_DIR = path.resolve(
  process.env.PUBLIC_DIR || path.join(__dirname, "..", "ui"),
);
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolvePublicFile(
  pathname: string,
): { abs: string; type: string } | undefined {
  const decoded = decodeURIComponent(pathname);
  if (!decoded.startsWith("/") || decoded.includes("\0")) return undefined;
  const relative = decoded === "/" ? "/index.html" : decoded;
  const abs = path.resolve(PUBLIC_DIR, `.${relative}`);
  const root = path.resolve(PUBLIC_DIR) + path.sep;
  if (abs !== path.resolve(PUBLIC_DIR) && !abs.startsWith(root)) {
    return undefined;
  }
  try {
    if (!fs.statSync(abs).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return {
    abs,
    type: MIME_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type SessionRole = "admin" | "user";

interface SessionRecord {
  expires: number;
  role: SessionRole;
  profileId?: number;
  impersonating?: boolean;
}

class Sessions {
  private readonly sessions = new Map<string, SessionRecord>();

  create(data: {
    role: SessionRole;
    profileId?: number;
    impersonating?: boolean;
  }): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      expires: Date.now() + SESSION_TTL_MS,
      role: data.role,
      profileId: data.profileId,
      impersonating: !!data.impersonating,
    });
    return token;
  }

  get(token: string | undefined): SessionRecord | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expires < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    session.expires = Date.now() + SESSION_TTL_MS;
    return session;
  }

  isValid(token: string | undefined): boolean {
    return !!this.get(token);
  }

  update(
    token: string | undefined,
    patch: {
      role?: SessionRole;
      profileId?: number | null;
      impersonating?: boolean;
    },
  ): SessionRecord | undefined {
    const session = this.get(token);
    if (!session) return undefined;
    if (patch.role !== undefined) session.role = patch.role;
    if (patch.profileId === null) delete session.profileId;
    else if (patch.profileId !== undefined) session.profileId = patch.profileId;
    if (patch.impersonating !== undefined) {
      session.impersonating = patch.impersonating;
    }
    return session;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

type Handler = (ctx: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: string[];
  body: any;
  url: URL;
  session: SessionRecord | null;
}) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  public?: boolean;
  /** Default for non-public routes is admin (not impersonating). */
  access?: "admin" | "user";
}

function parseIsoQuery(value: string | null, name: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `Invalid ${name}`);
  return date.toISOString();
}

function parseNotifiedQuery(value: string | null): boolean | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  throw new HttpError(400, "Invalid notified");
}

function parseNotificationKind(
  value: string | null,
):
  | "appointment"
  | "heartbeat"
  | "failure"
  | "test"
  | "intake"
  | "invite"
  | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (
    raw === "appointment" ||
    raw === "heartbeat" ||
    raw === "failure" ||
    raw === "test" ||
    raw === "intake" ||
    raw === "invite"
  ) {
    return raw;
  }
  throw new HttpError(400, "Invalid kind");
}

function parseNotificationStatus(
  value: string | null,
): "sent" | "failed" | "skipped" | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "sent" || raw === "failed" || raw === "skipped") return raw;
  throw new HttpError(400, "Invalid status");
}

function parseNotificationChannel(
  value: string | null,
): string | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "email" || raw === "whatsapp") return raw;
  throw new HttpError(400, "Invalid channel");
}

async function openwaClientFrom(store: Store): Promise<OpenwaClient> {
  const baseUrl = configuredOpenwaBaseUrl();
  const apiKey = await store.getOpenwaApiKey();
  if (!baseUrl || !apiKey) {
    throw new ValidationError("OpenWA is not configured on this host");
  }
  return new OpenwaClient({ baseUrl, apiKey });
}

function parseOrderQuery(value: string | null): "asc" | "desc" {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === "desc") return "desc";
  if (raw === "asc") return "asc";
  throw new HttpError(400, "Invalid order");
}

function getCookie(req: http.IncomingMessage, name: string) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
  https = false,
) {
  res.writeHead(status, securityHeaders({ contentType, https }));
  res.end(body);
}

const sendJson = (
  res: http.ServerResponse,
  status: number,
  data: unknown,
  https = false,
) =>
  send(
    res,
    status,
    JSON.stringify(data),
    "application/json; charset=utf-8",
    https,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const db = await openDatabase();
  const store = new Store(db, SecretBox.fromEnvironment());
  await store.initialize();

  const notifier = new Notifier(store);
  const scheduler = new Scheduler(store, notifier);
  const intake = new IntakeMonitor(store, notifier);
  const sessions = new Sessions();
  const adminLoginLockout = new LoginLockout();
  const userLoginLockout = new LoginLockout();
  let lastAdminLockoutNotifyAt = 0;

  const profileId = (params: string[]) => Number(params[0]);

  const requireProfile = async (id: number) => {
    const profile = await store.getProfile(id);
    if (!profile) throw new HttpError(404, "Profile not found");
    return profile;
  };

  const clientMeta = (req: http.IncomingMessage) => ({
    ip: clientIp(req) || null,
    userAgent: req.headers["user-agent"] || null,
  });

  const assertAdminIpAllowed = (req: http.IncomingMessage) => {
    if (!ADMIN_IP_ALLOWLIST.length) return;
    if (!ipAllowed(clientIp(req), ADMIN_IP_ALLOWLIST)) {
      throw new HttpError(404, "Not found");
    }
  };

  const maybeNotifyAdminLockout = (ip: string) => {
    const now = Date.now();
    if (now - lastAdminLockoutNotifyAt < 15 * 60 * 1000) return;
    lastAdminLockoutNotifyAt = now;
    void notifier
      .notifySecurityAlert(
        `Admin login locked out after too many failed attempts (ip ${ip || "unknown"}).`,
      )
      .catch((error) => {
        console.error("Admin lockout notification failed:", error);
      });
  };

  const audit = async (
    input: Parameters<Store["recordPortalAudit"]>[0],
    req: http.IncomingMessage,
  ) => {
    const meta = clientMeta(req);
    await store.recordPortalAudit({
      ...input,
      ip: input.ip ?? meta.ip,
      userAgent: input.userAgent ?? meta.userAgent,
    });
  };

  const portalActor = (
    session: SessionRecord | null,
  ): "user" | "admin_impersonation" =>
    session?.impersonating ? "admin_impersonation" : "user";

  const effectiveUserProfileId = (
    session: SessionRecord | null,
  ): number | null => {
    if (!session) return null;
    if (session.role === "user" && session.profileId) return session.profileId;
    if (session.role === "admin" && session.impersonating && session.profileId) {
      return session.profileId;
    }
    return null;
  };

  const requireUserContext = async (
    session: SessionRecord | null,
  ): Promise<{ profileId: number; impersonating: boolean }> => {
    if (DEV && !session) {
      throw new HttpError(
        401,
        "User portal requires a session (sign in or impersonate)",
      );
    }
    const id = effectiveUserProfileId(session);
    if (!id) throw new HttpError(401, "Not authenticated");
    const profile = await store.getProfile(id);
    if (!profile) throw new HttpError(401, "Not authenticated");
    const impersonating = !!session?.impersonating;
    if (!impersonating && !profile.portalAccessEnabled) {
      throw new HttpError(401, "Portal access is disabled for this account");
    }
    if (!impersonating && session?.role === "user" && !profile.portalRegistered) {
      throw new HttpError(401, "Not authenticated");
    }
    return { profileId: id, impersonating };
  };

  const resolvePublicBaseUrl = async (req: http.IncomingMessage) => {
    const settings = await store.getSettings();
    if (settings.publicBaseUrl) return settings.publicBaseUrl.replace(/\/$/, "");
    const host = req.headers.host;
    if (!host) {
      throw new ValidationError(
        "Set Public base URL in Settings (or PUBLIC_BASE_URL) so invite links work",
      );
    }
    const proto =
      (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
      "http";
    return `${proto}://${host}`.replace(/\/$/, "");
  };

  const sendInviteForProfile = async (
    id: number,
    req: http.IncomingMessage,
  ) => {
    let baseOverride: string | undefined;
    try {
      baseOverride = await resolvePublicBaseUrl(req);
    } catch {
      baseOverride = undefined;
    }
    const sent = await notifier.inviteProfile(id, baseOverride);
    await audit(
      {
        profileId: id,
        actor: "admin",
        action: "invite_sent",
        detail: { emailed: sent.emailed, whatsapped: sent.whatsapped },
      },
      req,
    );
    return {
      ok: true,
      expiresAt: sent.expiresAt,
      emailed: sent.emailed,
      whatsapped: sent.whatsapped,
      profile: await store.getProfile(id),
    };
  };

  const sessionPayload = async (
    req: http.IncomingMessage,
    session: SessionRecord | null,
  ) => {
    const setupRequired = !DEV && !(await store.hasAdminPassword());
    if (DEV && !session) {
      return {
        authenticated: true,
        role: "admin" as const,
        setupRequired: false,
        dev: true,
        impersonating: false,
        portalAccessEnabled: true,
        turnstileSiteKey: turnstileSiteKey(),
        turnstileRequired: false,
      };
    }
    if (!session) {
      return {
        authenticated: false,
        role: null,
        setupRequired,
        dev: DEV,
        impersonating: false,
        turnstileSiteKey: turnstileSiteKey(),
        turnstileRequired: turnstileRequired(),
      };
    }
    const userId = effectiveUserProfileId(session);
    let profileName: string | null = null;
    let visaEmail: string | null = null;
    let portalAccessEnabled = true;
    if (userId) {
      const profile = await store.getProfile(userId);
      if (profile) {
        profileName = profile.name;
        visaEmail = profile.visaEmail;
        portalAccessEnabled = profile.portalAccessEnabled;
      } else if (session.role === "user") {
        return {
          authenticated: false,
          role: null,
          setupRequired,
          dev: DEV,
          impersonating: false,
          turnstileSiteKey: turnstileSiteKey(),
          turnstileRequired: turnstileRequired(),
        };
      }
    }
    const inUserView =
      session.role === "user" ||
      (session.role === "admin" && !!session.impersonating);
    return {
      authenticated: true,
      role: inUserView ? "user" : "admin",
      realRole: session.role,
      setupRequired: false,
      dev: DEV,
      profileId: userId,
      profileName,
      visaEmail,
      impersonating: !!session.impersonating,
      portalAccessEnabled,
      turnstileSiteKey: turnstileSiteKey(),
      turnstileRequired: turnstileRequired(),
    };
  };

  /**
   * Probe AIS (credentials, booked date, visa fingerprint), then enable.
   * Leaves the profile disabled on probe or overlap failure.
   */
  const enableWithProbe = async (id: number) => {
    await requireProfile(id);
    if (scheduler.getState(id) !== "idle") {
      throw new ValidationError(
        "Profile is already running or queued; try again when idle",
      );
    }
    let probe;
    try {
      probe = await scheduler.runProbe(id);
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (probe.status !== "success" || !probe.result || probe.result.outcome === "error") {
      throw new ValidationError(
        probe.result?.error ||
          (probe.status === "timeout"
            ? "AIS check timed out"
            : probe.status === "cancelled"
              ? "AIS check was cancelled"
              : "AIS check failed"),
      );
    }
    if (!probe.result.visaClasses.length) {
      throw new ValidationError("AIS check returned no visa classes");
    }
    await store.setProfileEnabled(id, true);
    // Probe must not delay the first real search/notify — start one now.
    scheduler.enqueue(id, "enable");
  };

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/api\/session$/,
      public: true,
      handler: async ({ req, session }) => sessionPayload(req, session),
    },
    {
      method: "POST",
      pattern: /^\/api\/setup$/,
      public: true,
      handler: async ({ req, res, body }) => {
        assertAdminIpAllowed(req);
        if (await store.hasAdminPassword()) {
          throw new HttpError(409, "Admin password already set");
        }
        await verifyTurnstileToken(body.turnstileToken, clientIp(req));
        await store.setAdminPassword(String(body.password ?? ""));
        const token = sessions.create({ role: "admin" });
        res.setHeader(
          "Set-Cookie",
          sessionCookie(token, SESSION_TTL_MS / 1000, requestIsHttps(req)),
        );
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/login$/,
      public: true,
      handler: async ({ req, res, body }) => {
        assertAdminIpAllowed(req);
        const ip = clientIp(req);
        if (adminLoginLockout.isLocked(ip)) {
          throw new HttpError(429, "Too many failed attempts, try later");
        }
        await verifyTurnstileToken(body.turnstileToken, ip);
        if (!(await store.verifyAdminPassword(String(body.password ?? "")))) {
          if (adminLoginLockout.recordFailure(ip)) {
            maybeNotifyAdminLockout(ip);
          }
          await sleep(1000);
          throw new HttpError(401, "Wrong password");
        }
        adminLoginLockout.clear(ip);
        const token = sessions.create({ role: "admin" });
        res.setHeader(
          "Set-Cookie",
          sessionCookie(token, SESSION_TTL_MS / 1000, requestIsHttps(req)),
        );
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/user\/login$/,
      public: true,
      handler: async ({ req, res, body }) => {
        const ip = clientIp(req);
        const email = String(body.email ?? "").trim().toLowerCase();
        if (userLoginLockout.isLocked(ip, email)) {
          throw new HttpError(429, "Too many failed attempts, try later");
        }
        await verifyTurnstileToken(body.turnstileToken, ip);
        try {
          const profile = await store.verifyPortalLogin(
            email,
            String(body.password ?? ""),
          );
          userLoginLockout.clear(ip, email);
          const token = sessions.create({
            role: "user",
            profileId: profile.id,
          });
          res.setHeader(
            "Set-Cookie",
            sessionCookie(token, SESSION_TTL_MS / 1000, requestIsHttps(req)),
          );
          await audit(
            {
              profileId: profile.id,
              actor: "user",
              action: "login_success",
              detail: { email: profile.visaEmail },
            },
            req,
          );
          return { ok: true };
        } catch (error) {
          const auditReason =
            error instanceof ValidationError
              ? error.message
              : "Wrong email or password";
          const profile = email
            ? await store.findProfileByVisaEmail(email)
            : undefined;
          await audit(
            {
              profileId: profile?.id ?? null,
              actor: "user",
              action: "login_failure",
              detail: { email: email || null, reason: auditReason },
            },
            req,
          );
          userLoginLockout.recordFailure(ip, email);
          await sleep(1000);
          throw new HttpError(401, "Wrong email or password");
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/user\/register$/,
      public: true,
      handler: async ({ req, res, body }) => {
        const token = String(body.token ?? "").trim();
        const password = String(body.password ?? "");
        await verifyTurnstileToken(body.turnstileToken, clientIp(req));
        try {
          const profile = await store.registerPortalUser(token, password);
          const sid = sessions.create({
            role: "user",
            profileId: profile.id,
          });
          res.setHeader(
            "Set-Cookie",
            sessionCookie(sid, SESSION_TTL_MS / 1000, requestIsHttps(req)),
          );
          await audit(
            {
              profileId: profile.id,
              actor: "user",
              action: "register",
              detail: { email: profile.visaEmail },
            },
            req,
          );
          return { ok: true, profile: store.toUserPortalView(profile) };
        } catch (error) {
          if (error instanceof ValidationError) {
            throw new HttpError(400, error.message);
          }
          throw error;
        }
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/user\/invite$/,
      public: true,
      handler: async ({ url }) => {
        const token = String(url.searchParams.get("token") ?? "").trim();
        const profile = await store.findProfileByInviteToken(token);
        if (!profile) {
          throw new HttpError(400, "Invite link is invalid or expired");
        }
        if (!profile.portalAccessEnabled) {
          throw new HttpError(400, "Portal access is disabled for this account");
        }
        return {
          name: profile.name,
          visaEmail: profile.visaEmail,
          expiresAt: profile.portalInviteExpiresAt,
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/logout$/,
      public: true,
      handler: async ({ req, res, session }) => {
        const sid = getCookie(req, "sid");
        // Impersonating admin: logout exits impersonation and keeps the admin session.
        if (session?.role === "admin" && session.impersonating) {
          await audit(
            {
              profileId: session.profileId ?? null,
              actor: "admin",
              action: "impersonate_stop",
              detail: { via: "logout" },
            },
            req,
          );
          sessions.update(sid, { impersonating: false, profileId: null });
          return { ok: true, returnedToAdmin: true };
        }
        if (session?.role === "user" && session.profileId) {
          await audit(
            {
              profileId: session.profileId,
              actor: "user",
              action: "logout",
            },
            req,
          );
        }
        sessions.destroy(sid);
        res.setHeader(
          "Set-Cookie",
          sessionCookie("", 0, requestIsHttps(req)),
        );
        return { ok: true };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/user\/me$/,
      access: "user",
      handler: async ({ session }) => {
        const { profileId: id, impersonating } =
          await requireUserContext(session);
        const profile = await requireProfile(id);
        const [latestRuns, successfulRuns, settings] = await Promise.all([
          store.getLatestRuns(),
          store.getProfilesWithSuccessfulRuns(),
          store.getSettings(),
        ]);
        const lastRun = latestRuns.get(id) ?? null;
        const lastSearchStartedAt =
          lastRun && lastRun.trigger !== "probe" ? lastRun.startedAt : null;
        const intervalMs = settings.intervalMinutes * 60 * 1000;
        return {
          ...store.toUserPortalView(profile),
          impersonating,
          state: scheduler.getState(id),
          lastRun: lastRun
            ? {
                id: lastRun.id,
                status: lastRun.status,
                trigger: lastRun.trigger,
                startedAt: lastRun.startedAt,
                finishedAt: lastRun.finishedAt,
                result: lastRun.result,
              }
            : null,
          hasSuccessfulRun: successfulRuns.has(id),
          nextRunAt: Scheduler.nextRunAt(
            profile.enabled,
            lastSearchStartedAt,
            intervalMs,
          ),
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/user\/runs$/,
      access: "user",
      handler: async ({ session, url }) => {
        const { profileId: id } = await requireUserContext(session);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
        const runs = await store.listRuns(id, limit);
        return {
          runs: runs.map((run) => ({
            id: run.id,
            status: run.status,
            trigger: run.trigger,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            result: run.result,
          })),
        };
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/user\/dates$/,
      access: "user",
      handler: async ({ req, session, body }) => {
        const { profileId: id, impersonating } =
          await requireUserContext(session);
        const before = await requireProfile(id);
        const minDate =
          body.minDate === undefined || body.minDate === ""
            ? null
            : String(body.minDate);
        const maxDate =
          body.maxDate === undefined || body.maxDate === ""
            ? null
            : String(body.maxDate);
        const profile = await store.updateUserDates(id, minDate, maxDate);
        await audit(
          {
            profileId: id,
            actor: portalActor(session),
            action: "update_dates",
            detail: {
              before: { minDate: before.minDate, maxDate: before.maxDate },
              after: { minDate: profile.minDate, maxDate: profile.maxDate },
              impersonating,
            },
          },
          req,
        );
        return store.toUserPortalView(profile);
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/user\/visa-password$/,
      access: "user",
      handler: async ({ req, session, body }) => {
        const { profileId: id, impersonating } =
          await requireUserContext(session);
        const profile = await store.updateUserVisaPassword(
          id,
          String(body.visaPassword ?? ""),
        );
        await audit(
          {
            profileId: id,
            actor: portalActor(session),
            action: "update_visa_password",
            detail: { changed: true, impersonating },
          },
          req,
        );
        return store.toUserPortalView(profile);
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/user\/portal-password$/,
      access: "user",
      handler: async ({ req, session, body }) => {
        const { profileId: id, impersonating } =
          await requireUserContext(session);
        const profile = await store.updatePortalPassword(id, {
          currentPassword: String(body.currentPassword ?? ""),
          newPassword: String(body.newPassword ?? ""),
          requireCurrent: !impersonating,
        });
        await audit(
          {
            profileId: id,
            actor: portalActor(session),
            action: "update_portal_password",
            detail: { changed: true, impersonating },
          },
          req,
        );
        return store.toUserPortalView(profile);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/invite$/,
      access: "admin",
      handler: async ({ req, params }) => {
        const id = profileId(params);
        await requireProfile(id);
        return sendInviteForProfile(id, req);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/portal-access$/,
      access: "admin",
      handler: async ({ req, params, body }) => {
        const id = profileId(params);
        await requireProfile(id);
        const enabled = !!body.enabled;
        const profile = await store.setPortalAccessEnabled(id, enabled);
        await audit(
          {
            profileId: id,
            actor: "admin",
            action: enabled ? "portal_access_enabled" : "portal_access_disabled",
          },
          req,
        );
        return profile;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/admin\/impersonate$/,
      access: "admin",
      handler: async ({ req, res, body, session }) => {
        const id = Number(body.profileId);
        if (!Number.isInteger(id) || id < 1) {
          throw new HttpError(400, "Invalid profileId");
        }
        const profile = await requireProfile(id);
        if (!session || session.role !== "admin") {
          throw new HttpError(401, "Not authenticated");
        }
        const sid = getCookie(req, "sid");
        const updated = sessions.update(sid, {
          impersonating: true,
          profileId: id,
        });
        // Dev may have an ephemeral admin session with no cookie yet.
        if (!updated) {
          const token = sessions.create({
            role: "admin",
            impersonating: true,
            profileId: id,
          });
          res.setHeader(
            "Set-Cookie",
            sessionCookie(token, SESSION_TTL_MS / 1000, requestIsHttps(req)),
          );
        }
        await audit(
          {
            profileId: id,
            actor: "admin",
            action: "impersonate_start",
            detail: {
              name: profile.name,
              portalAccessEnabled: profile.portalAccessEnabled,
            },
          },
          req,
        );
        return {
          ok: true,
          profileId: id,
          name: profile.name,
          visaEmail: profile.visaEmail,
          portalAccessEnabled: profile.portalAccessEnabled,
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/admin\/stop-impersonation$/,
      public: true,
      handler: async ({ req, session }) => {
        if (!session || (!session.impersonating && session.role !== "admin")) {
          throw new HttpError(400, "Not impersonating");
        }
        if (!session.impersonating) {
          throw new HttpError(400, "Not impersonating");
        }
        const profileIdValue = session.profileId ?? null;
        await audit(
          {
            profileId: profileIdValue,
            actor: "admin",
            action: "impersonate_stop",
          },
          req,
        );
        sessions.update(getCookie(req, "sid"), {
          impersonating: false,
          profileId: null,
        });
        return { ok: true };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/portal-audit$/,
      access: "admin",
      handler: async ({ url }) => {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
        const from = parseIsoQuery(url.searchParams.get("from"), "from");
        const to = parseIsoQuery(url.searchParams.get("to"), "to");
        if (from && to && from > to) throw new HttpError(400, "From must be before To");
        const rawProfile = url.searchParams.get("profileId");
        let filterProfileId: number | null | undefined;
        if (rawProfile) {
          filterProfileId = Number(rawProfile);
          if (!Number.isInteger(filterProfileId) || filterProfileId < 1) {
            throw new HttpError(400, "Invalid profileId");
          }
        }
        const action = url.searchParams.get("action")?.trim() || null;
        return {
          audits: await store.listPortalAudit(limit, {
            profileId: filterProfileId,
            action,
            from,
            to,
          }),
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/profiles$/,
      access: "admin",
      handler: async () => {
        const [profiles, latestRuns, successfulRuns, settings] =
          await Promise.all([
            store.listProfiles(),
            store.getLatestRuns(),
            store.getProfilesWithSuccessfulRuns(),
            store.getSettings(),
          ]);
        const intervalMs = settings.intervalMinutes * 60 * 1000;
        return profiles.map((profile) => {
          const lastRun = latestRuns.get(profile.id) ?? null;
          // Probe-only runs do not advance the search schedule.
          const lastSearchStartedAt =
            lastRun && lastRun.trigger !== "probe"
              ? lastRun.startedAt
              : null;
          const lag = scheduler.isBehind(
            profile.id,
            lastSearchStartedAt,
            intervalMs,
          );
          return {
            ...profile,
            state: scheduler.getState(profile.id),
            lastRun,
            hasSuccessfulRun: successfulRuns.has(profile.id),
            nextRunAt: Scheduler.nextRunAt(
              profile.enabled,
              lastSearchStartedAt,
              intervalMs,
            ),
            behind: lag.behind,
            behindMs: lag.elapsedMs,
          };
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/intake$/,
      handler: async ({ body }) => {
        const profile = await store.createIntake(
          String(body.name ?? ""),
          String(body.phone ?? ""),
        );
        try {
          await intake.sendPrompt(profile);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await store.setIntakeError(profile.id, message);
        }
        intake.kick();
        return (await store.getProfile(profile.id))!;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/intake\/resend$/,
      handler: async ({ params }) => {
        const profile = await requireProfile(profileId(params));
        if (profile.intakeStatus === "ready") {
          throw new ValidationError("This profile is already complete");
        }
        try {
          await intake.sendPrompt(profile);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await store.setIntakeError(profile.id, message);
          throw new ValidationError(message);
        }
        intake.kick();
        return (await store.getProfile(profile.id))!;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles$/,
      access: "admin",
      handler: async ({ req, body }) => {
        const wantEnabled = !!body.enabled;
        const profile = await store.createProfile({ ...body, enabled: false });
        if (wantEnabled) {
          try {
            await enableWithProbe(profile.id);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new ValidationError(
              `Profile saved but not enabled: ${message}`,
            );
          }
        }
        try {
          await sendInviteForProfile(profile.id, req);
        } catch (error) {
          console.warn(
            `Portal invite not sent for profile ${profile.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
        return (await store.getProfile(profile.id))!;
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/profiles\/(\d+)$/,
      access: "admin",
      handler: async ({ params, body }) => {
        const id = profileId(params);
        const existing = await requireProfile(id);
        const wantEnabled = !!body.enabled;
        const turningOn = wantEnabled && !existing.enabled;
        // updateProfile keeps enabled only when already on; turning on uses probe.
        try {
          await store.updateProfile(id, {
            ...body,
            enabled: wantEnabled && existing.enabled,
          });
          if (turningOn) {
            try {
              await enableWithProbe(id);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new ValidationError(
                `Profile saved but not enabled: ${message}`,
              );
            }
          } else if (!wantEnabled && existing.enabled) {
            await store.setProfileEnabled(id, false);
          }
          return (await store.getProfile(id))!;
        } finally {
          intake.kick();
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/test-notification$/,
      handler: async ({ params, body }) => {
        const id = profileId(params);
        await requireProfile(id);
        return notifier.sendProfileTest(id, {
          emailDestination:
            body.emailDestination === undefined
              ? undefined
              : String(body.emailDestination),
          whatsappDestination:
            body.whatsappDestination === undefined
              ? undefined
              : String(body.whatsappDestination),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/enabled$/,
      handler: async ({ params, body }) => {
        const id = profileId(params);
        await requireProfile(id);
        if (body.enabled) {
          await enableWithProbe(id);
        } else {
          await store.setProfileEnabled(id, false);
        }
        return { ok: true };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/profiles\/(\d+)$/,
      handler: async ({ params }) => {
        const id = profileId(params);
        scheduler.cancel(id);
        intake.cancel(id);
        try {
          await store.deleteProfile(id);
        } catch (error) {
          intake.restore(id);
          throw error;
        }
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/run$/,
      handler: async ({ params }) => {
        const profile = await requireProfile(profileId(params));
        if (profile.intakeStatus !== "ready") {
          throw new ValidationError(
            "This profile is still waiting for visa account details",
          );
        }
        if (!scheduler.enqueue(profile.id, "manual")) {
          throw new HttpError(409, "Already running or queued");
        }
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/cancel$/,
      handler: async ({ params }) => ({
        ok: scheduler.cancel(profileId(params)),
      }),
    },
    {
      method: "GET",
      pattern: /^\/api\/profiles\/(\d+)\/logs$/,
      handler: async ({ params, url }) => {
        const profile = await requireProfile(profileId(params));
        if (!profile.visaProcessId) return [];
        const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
        return store.listLogs(profile.visaProcessId, limit);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/profiles\/(\d+)\/runs$/,
      handler: async ({ params, url }) => {
        const id = profileId(params);
        await requireProfile(id);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
        const from = parseIsoQuery(url.searchParams.get("from"), "from");
        const to = parseIsoQuery(url.searchParams.get("to"), "to");
        if (from && to && from > to) throw new HttpError(400, "From must be before To");
        const notified = parseNotifiedQuery(url.searchParams.get("notified"));
        const order = parseOrderQuery(url.searchParams.get("order"));
        const [runs, notifiedRange] = await Promise.all([
          store.listRuns(id, limit, { from, to, notified, order }),
          store.getNotifiedRange(id, { from, to }),
        ]);
        return { runs, notified: notifiedRange };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs$/,
      handler: async ({ url }) => {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
        const from = parseIsoQuery(url.searchParams.get("from"), "from");
        const to = parseIsoQuery(url.searchParams.get("to"), "to");
        if (from && to && from > to) throw new HttpError(400, "From must be before To");
        const notified = parseNotifiedQuery(url.searchParams.get("notified"));
        const order = parseOrderQuery(url.searchParams.get("order"));
        const rawProfile = url.searchParams.get("profileId");
        let profileId: number | null = null;
        if (rawProfile) {
          profileId = Number(rawProfile);
          if (!Number.isInteger(profileId) || profileId < 1) {
            throw new HttpError(400, "Invalid profileId");
          }
          await requireProfile(profileId);
        }
        const [runs, notifiedRange] = await Promise.all([
          store.listRuns(profileId, limit, { from, to, notified, order }),
          store.getNotifiedRange(profileId, { from, to }),
        ]);
        return { runs, notified: notifiedRange };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(\d+)$/,
      handler: async ({ params }) => {
        const run = await store.getRun(Number(params[0]));
        if (!run) throw new HttpError(404, "Run not found");
        return run;
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/settings$/,
      handler: async () => store.getSettings(),
    },
    {
      method: "PUT",
      pattern: /^\/api\/settings$/,
      handler: async ({ body }) => store.updateSettings(body),
    },
    {
      method: "POST",
      pattern: /^\/api\/heartbeat$/,
      handler: async () => notifier.sendHeartbeat({ force: true }),
    },
    {
      method: "POST",
      pattern: /^\/api\/settings\/test-notification$/,
      handler: async ({ body }) => {
        const channel = String(body.channel ?? "").trim();
        if (channel !== "email" && channel !== "whatsapp") {
          throw new HttpError(400, "channel must be email or whatsapp");
        }
        return notifier.sendTest({
          channel,
          gmailUser: body.gmailUser,
          gmailAppPassword: body.gmailAppPassword,
          emailAdminDestination: body.emailAdminDestination,
          openwaSessionId: body.openwaSessionId,
          whatsappAdminDestination: body.whatsappAdminDestination,
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/settings\/openwa\/session$/,
      handler: async ({ body }) => {
        try {
          const client = await openwaClientFrom(store);
          const result = await ensureOpenwaSession(
            client,
            String(body.openwaSessionId ?? ""),
          );
          await store.setOpenwaSessionId(result.session.id);
          return result;
        } catch (error) {
          if (error instanceof WhatsAppError) {
            throw new ValidationError(error.message);
          }
          throw error;
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/settings\/openwa\/session\/status$/,
      handler: async ({ body }) => {
        try {
          const client = await openwaClientFrom(store);
          const sessionId = String(body.openwaSessionId ?? "").trim();
          const result = await readOpenwaSession(client, sessionId);
          return result;
        } catch (error) {
          if (error instanceof WhatsAppError) {
            throw new ValidationError(error.message);
          }
          throw error;
        }
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/notifications$/,
      handler: async ({ url }) => {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
        const from = parseIsoQuery(url.searchParams.get("from"), "from");
        const to = parseIsoQuery(url.searchParams.get("to"), "to");
        if (from && to && from > to) throw new HttpError(400, "From must be before To");
        const kind = parseNotificationKind(url.searchParams.get("kind"));
        const status = parseNotificationStatus(url.searchParams.get("status"));
        const channel = parseNotificationChannel(url.searchParams.get("channel"));
        return {
          notifications: await store.listNotifications(limit, {
            from,
            to,
            kind,
            status,
            channel,
          }),
        };
      },
    },
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const https = requestIsHttps(req);

    try {
      // Raw files in public/ need Vite to resolve CSS/JS imports. Send the
      // browser there instead of serving an unstyled page from the API port.
      if (DEV && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        res.writeHead(302, {
          Location: `${VITE_ORIGIN}${url.pathname}${url.search}`,
        });
        res.end();
        return;
      }

      if (
        req.method === "GET" &&
        (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      ) {
        assertAdminIpAllowed(req);
      }

      const staticFile =
        req.method === "GET" &&
        !url.pathname.startsWith("/api/") &&
        resolvePublicFile(url.pathname);
      if (staticFile) {
        return send(
          res,
          200,
          await fs.promises.readFile(staticFile.abs),
          staticFile.type,
          https,
        );
      }

      // SPA shell for client routes (admin login lives at /admin).
      if (
        req.method === "GET" &&
        (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      ) {
        const index = resolvePublicFile("/index.html");
        if (!index) throw new HttpError(404, "Not found");
        return send(
          res,
          200,
          await fs.promises.readFile(index.abs),
          index.type,
          https,
        );
      }

      let params: string[] | undefined;
      const route = routes.find((candidate) => {
        if (candidate.method !== req.method) return false;
        const match = candidate.pattern.exec(url.pathname);
        params = match?.slice(1);
        return !!match;
      });
      if (!route) throw new HttpError(404, "Not found");

      const sid = getCookie(req, "sid");
      let session = sessions.get(sid) ?? null;
      if (DEV && !session && !route.public) {
        session = { expires: Date.now() + SESSION_TTL_MS, role: "admin" };
      }

      if (!route.public) {
        if (!session) {
          throw new HttpError(401, "Not authenticated");
        }
        const access = route.access ?? "admin";
        if (access === "admin") {
          assertAdminIpAllowed(req);
          if (session.role !== "admin" || session.impersonating) {
            throw new HttpError(403, "Admin access required");
          }
        } else if (access === "user") {
          const userId = effectiveUserProfileId(session);
          if (!userId) {
            throw new HttpError(401, "Not authenticated");
          }
        }
      }

      let body: any = {};
      if (req.method !== "GET") {
        // Cross-site forms can't send application/json without a CORS
        // preflight, which this server never approves.
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          throw new HttpError(415, "Expected application/json");
        }
        const settings = await store.getSettings();
        try {
          assertSameOrigin(req, {
            publicBaseUrl: settings.publicBaseUrl || undefined,
            extraHosts: DEV
              ? [`127.0.0.1:${process.env.VITE_DEV_PORT || "5173"}`, `localhost:${process.env.VITE_DEV_PORT || "5173"}`]
              : [],
          });
        } catch (error) {
          const status =
            error &&
            typeof error === "object" &&
            "statusCode" in error &&
            typeof (error as { statusCode: unknown }).statusCode === "number"
              ? (error as { statusCode: number }).statusCode
              : 403;
          throw new HttpError(status, "Invalid origin");
        }
        body = await readJson(req);
      }

      sendJson(
        res,
        200,
        await route.handler({
          req,
          res,
          params: params!,
          body,
          url,
          session,
        }),
        https,
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        typeof (error as { statusCode: unknown }).statusCode === "number"
      ) {
        const status = (error as { statusCode: number; message?: string })
          .statusCode;
        sendJson(
          res,
          status,
          {
            error:
              (error as { message?: string }).message || "Request rejected",
          },
          https,
        );
      } else if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message }, https);
      } else if (error instanceof ValidationError) {
        sendJson(res, 400, { error: error.message }, https);
      } else {
        console.error(`${req.method} ${url.pathname} failed:`, error);
        sendJson(res, 500, { error: "Internal server error" }, https);
      }
    }
  });

  intake.start();
  if (DEV) {
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      throw Error("VISA_DEV is only allowed when HOST is 127.0.0.1");
    }
    console.warn(
      `Dev mode — login skipped; scheduled checks and automatic heartbeats off. Open ${VITE_ORIGIN}`,
    );
  } else {
    await scheduler.start();
    await notifier.start();
  }
  server.listen(PORT, HOST, () => {
    if (DEV) {
      console.log(`API listening on http://${HOST}:${PORT}`);
      console.log(`Open the UI at ${VITE_ORIGIN}`);
    } else {
      console.log(`Management UI listening on http://${HOST}:${PORT}`);
    }
  });
  if (!(await store.hasAdminPassword())) {
    console.warn(
      "No admin password set. Open /admin to create one, or run: node build/server/cli.js set-password",
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    server.close();
    intake.stop();
    await scheduler.stop();
    await notifier.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
