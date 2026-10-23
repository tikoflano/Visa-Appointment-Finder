import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
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
const LOGIN_LOCKOUT_THRESHOLD = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const DEV =
  process.env.VISA_DEV === "1" || process.env.VISA_DEV === "true";
const VITE_ORIGIN = `http://127.0.0.1:${process.env.VITE_DEV_PORT || "5173"}`;

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

class Sessions {
  private readonly sessions = new Map<string, number>();

  create(): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires || expires < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
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
}) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  public?: boolean;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${
    process.env.COOKIE_SECURE === "true" ? "; Secure" : ""
  }`;
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
): "appointment" | "heartbeat" | "failure" | "test" | "intake" | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (
    raw === "appointment" ||
    raw === "heartbeat" ||
    raw === "failure" ||
    raw === "test" ||
    raw === "intake"
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
) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(body);
}

const sendJson = (res: http.ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const db = await openDatabase();
  const store = new Store(db, SecretBox.fromEnvironment());
  await store.initialize();

  const notifier = new Notifier(store);
  const scheduler = new Scheduler(store, notifier);
  const intake = new IntakeMonitor(store, notifier);
  const sessions = new Sessions();
  const failedLogins: number[] = [];

  const profileId = (params: string[]) => Number(params[0]);

  const requireProfile = async (id: number) => {
    const profile = await store.getProfile(id);
    if (!profile) throw new HttpError(404, "Profile not found");
    return profile;
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
      handler: async ({ req }) => ({
        authenticated: DEV || sessions.isValid(getCookie(req, "sid")),
        setupRequired: !DEV && !(await store.hasAdminPassword()),
        dev: DEV,
      }),
    },
    {
      method: "POST",
      pattern: /^\/api\/setup$/,
      public: true,
      handler: async ({ res, body }) => {
        if (await store.hasAdminPassword()) {
          throw new HttpError(409, "Admin password already set");
        }
        await store.setAdminPassword(String(body.password ?? ""));
        const token = sessions.create();
        res.setHeader(
          "Set-Cookie",
          sessionCookie(token, SESSION_TTL_MS / 1000),
        );
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/login$/,
      public: true,
      handler: async ({ res, body }) => {
        const cutoff = Date.now() - LOGIN_LOCKOUT_MS;
        while (failedLogins.length && failedLogins[0] < cutoff) {
          failedLogins.shift();
        }
        if (failedLogins.length >= LOGIN_LOCKOUT_THRESHOLD) {
          throw new HttpError(429, "Too many failed attempts, try later");
        }

        if (!(await store.verifyAdminPassword(String(body.password ?? "")))) {
          failedLogins.push(Date.now());
          await sleep(1000);
          throw new HttpError(401, "Wrong password");
        }

        const token = sessions.create();
        res.setHeader(
          "Set-Cookie",
          sessionCookie(token, SESSION_TTL_MS / 1000),
        );
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/logout$/,
      handler: async ({ req, res }) => {
        sessions.destroy(getCookie(req, "sid"));
        res.setHeader("Set-Cookie", sessionCookie("", 0));
        return { ok: true };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/profiles$/,
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
      handler: async ({ body }) => {
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
        return (await store.getProfile(profile.id))!;
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/profiles\/(\d+)$/,
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

      if (!route.public && !DEV && !sessions.isValid(getCookie(req, "sid"))) {
        throw new HttpError(401, "Not authenticated");
      }

      let body: any = {};
      if (req.method !== "GET") {
        // Cross-site forms can't send application/json without a CORS
        // preflight, which this server never approves.
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          throw new HttpError(415, "Expected application/json");
        }
        body = await readJson(req);
      }

      sendJson(res, 200, await route.handler({ req, res, params: params!, body, url }));
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else if (error instanceof ValidationError) {
        sendJson(res, 400, { error: error.message });
      } else {
        console.error(`${req.method} ${url.pathname} failed:`, error);
        sendJson(res, 500, { error: "Internal server error" });
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
      "No admin password set. Open the UI to create one, or run: node build/server/cli.js set-password",
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
