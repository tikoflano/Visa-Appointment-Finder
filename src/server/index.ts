import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { DatabaseService } from "../services/DatabaseService";
import { EmailService } from "../services/EmailService";
import { NotificationService } from "../services/NotificationService";
import { Scheduler } from "./Scheduler";
import { SecretBox } from "./SecretBox";
import { openDatabase, Store, ValidationError } from "./Store";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 100 * 1024;
const LOGIN_LOCKOUT_THRESHOLD = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const DEV =
  process.env.VISA_DEV === "1" || process.env.VISA_DEV === "true";

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
      "default-src 'self'; frame-ancestors 'none'; form-action 'self'",
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

  const scheduler = new Scheduler(store);
  const sessions = new Sessions();
  const failedLogins: number[] = [];

  const profileId = (params: string[]) => Number(params[0]);

  const requireProfile = async (id: number) => {
    const profile = await store.getProfile(id);
    if (!profile) throw new HttpError(404, "Profile not found");
    return profile;
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
        const [profiles, latestRuns, lastLogs] = await Promise.all([
          store.listProfiles(),
          store.getLatestRuns(),
          store.getLastLogMessages(),
        ]);
        return profiles.map((profile) => ({
          ...profile,
          state: scheduler.getState(profile.id),
          lastRun: latestRuns.get(profile.id) ?? null,
          lastLog: lastLogs.get(profile.visaProcessId) ?? null,
        }));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles$/,
      handler: async ({ body }) => store.createProfile(body),
    },
    {
      method: "PUT",
      pattern: /^\/api\/profiles\/(\d+)$/,
      handler: async ({ params, body }) =>
        store.updateProfile(profileId(params), body),
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/enabled$/,
      handler: async ({ params, body }) => {
        await requireProfile(profileId(params));
        await store.setProfileEnabled(profileId(params), !!body.enabled);
        return { ok: true };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/profiles\/(\d+)$/,
      handler: async ({ params }) => {
        scheduler.cancel(profileId(params));
        await store.deleteProfile(profileId(params));
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/profiles\/(\d+)\/run$/,
      handler: async ({ params }) => {
        await requireProfile(profileId(params));
        if (!scheduler.enqueue(profileId(params), "manual")) {
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
        const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
        return store.listLogs(profile.visaProcessId, limit);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/profiles\/(\d+)\/runs$/,
      handler: async ({ params, url }) => {
        await requireProfile(profileId(params));
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
        return store.listRuns(profileId(params), limit);
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
      handler: async () => {
        const settings = await store.getSettings();
        if (!settings.emailAdminDestination) {
          throw new ValidationError("Admin notification emails are required");
        }
        if (!settings.gmailUser || !settings.hasGmailAppPassword) {
          throw new ValidationError("Gmail credentials are not configured");
        }
        const notify = new NotificationService(
          new DatabaseService(store.db),
          new EmailService({
            user: settings.gmailUser,
            pass: await store.getGmailAppPassword(),
          }),
        );
        await notify.sendHeartbeatNotification({
          force: true,
          destination: settings.emailAdminDestination,
          intervalMinutes: settings.heartbeatMinutes,
        });
        return {
          sent: true,
          lastHeartbeatAt: await store.getLastHeartbeatAt(),
        };
      },
    },
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    try {
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

  if (DEV) {
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      throw Error("VISA_DEV is only allowed when HOST is 127.0.0.1");
    }
    console.warn(
      `Dev mode on http://${HOST}:${PORT} — login skipped, scheduler off`,
    );
  } else {
    await scheduler.start();
  }
  server.listen(PORT, HOST, () => {
    console.log(`Management UI listening on http://${HOST}:${PORT}`);
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
    await scheduler.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
