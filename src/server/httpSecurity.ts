import http from "http";
import net from "net";

const LOGIN_LOCKOUT_THRESHOLD = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

export function requestIsHttps(req: http.IncomingMessage): boolean {
  if (process.env.COOKIE_SECURE === "true") return true;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto === "https") return true;
  const visitor = String(req.headers["cf-visitor"] || "");
  try {
    if (visitor && JSON.parse(visitor).scheme === "https") return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function clientIp(req: http.IncomingMessage): string {
  const cf = String(req.headers["cf-connecting-ip"] || "")
    .split(",")[0]
    .trim();
  if (cf) return cf;
  const xff = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (xff) return xff;
  return req.socket.remoteAddress || "";
}

export function isLoopbackIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase();
  if (!raw) return false;
  if (raw === "::1" || raw === "127.0.0.1" || raw === "localhost") return true;
  if (raw.startsWith("::ffff:")) {
    return isLoopbackIp(raw.slice("::ffff:".length));
  }
  return raw.startsWith("127.");
}

function normalizeIp(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (raw.startsWith("::ffff:")) return raw.slice("::ffff:".length);
  return raw;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

function ipMatchesEntry(ip: string, entry: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const normalizedEntry = normalizeIp(entry);
  if (!normalizedEntry) return false;
  if (normalizedEntry.includes("/")) {
    const [base, bitsRaw] = normalizedEntry.split("/");
    const bits = Number(bitsRaw);
    const ipInt = ipv4ToInt(normalizedIp);
    const baseInt = ipv4ToInt(base);
    if (
      ipInt == null ||
      baseInt == null ||
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > 32
    ) {
      return false;
    }
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }
  if (net.isIP(normalizedIp) && net.isIP(normalizedEntry)) {
    return normalizedIp === normalizedEntry;
  }
  return normalizedIp === normalizedEntry;
}

export function parseIpAllowlist(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function ipAllowed(
  ip: string,
  allowlist: string[],
  options?: { allowLoopback?: boolean },
): boolean {
  if (!allowlist.length) return true;
  if ((options?.allowLoopback ?? true) && isLoopbackIp(ip)) return true;
  return allowlist.some((entry) => ipMatchesEntry(ip, entry));
}

export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${
    secure ? "; Secure" : ""
  }`;
}

export function securityHeaders(options: {
  contentType: string;
  https: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
      "default-src 'self'",
      "img-src 'self' data:",
      "script-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "connect-src 'self' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  };
  if (options.https) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

export function assertSameOrigin(
  req: http.IncomingMessage,
  options?: { publicBaseUrl?: string; extraHosts?: string[] },
): void {
  const allowed = new Set<string>();
  const host = req.headers.host?.toLowerCase();
  if (host) allowed.add(host);
  if (options?.publicBaseUrl) {
    const fromPublic = hostFromUrl(options.publicBaseUrl);
    if (fromPublic) allowed.add(fromPublic);
  }
  for (const extra of options?.extraHosts || []) {
    const normalized = extra.trim().toLowerCase();
    if (normalized) allowed.add(normalized);
  }
  if (!allowed.size) return;

  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    const originHost = hostFromUrl(origin);
    if (!originHost || !allowed.has(originHost)) {
      throw Object.assign(new Error("Invalid origin"), { statusCode: 403 });
    }
    return;
  }

  const referer = String(req.headers.referer || "").trim();
  if (referer) {
    const refererHost = hostFromUrl(referer);
    if (!refererHost || !allowed.has(refererHost)) {
      throw Object.assign(new Error("Invalid origin"), { statusCode: 403 });
    }
    return;
  }

  throw Object.assign(new Error("Invalid origin"), { statusCode: 403 });
}

export function turnstileRequired(): boolean {
  const secret = String(process.env.TURNSTILE_SECRET_KEY || "").trim();
  if (secret) return true;
  // Docker always sets HOST=0.0.0.0, so treat public HTTPS exposure via
  // operator signals rather than bind address alone.
  if (process.env.TURNSTILE_REQUIRED === "true") return true;
  if (process.env.COOKIE_SECURE === "true") return true;
  if (String(process.env.PUBLIC_BASE_URL || "").startsWith("https://")) {
    return true;
  }
  const host = process.env.HOST || "127.0.0.1";
  return host !== "127.0.0.1" && host !== "localhost" && host !== "0.0.0.0";
}

export function turnstileSiteKey(): string | null {
  const key = String(process.env.TURNSTILE_SITE_KEY || "").trim();
  return key || null;
}

export async function verifyTurnstileToken(
  token: unknown,
  ip: string,
): Promise<void> {
  const secret = String(process.env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    if (!turnstileRequired()) return;
    throw Object.assign(new Error("Bot check is not configured"), {
      statusCode: 403,
    });
  }
  const responseToken = String(token ?? "").trim();
  if (!responseToken) {
    throw Object.assign(new Error("Bot check required"), { statusCode: 403 });
  }
  const body = new URLSearchParams({
    secret,
    response: responseToken,
  });
  if (ip) body.set("remoteip", ip);
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) {
    throw Object.assign(new Error("Bot check failed"), { statusCode: 403 });
  }
  const data = (await response.json()) as { success?: boolean };
  if (!data.success) {
    throw Object.assign(new Error("Bot check failed"), { statusCode: 403 });
  }
}

/** Sliding-window failed-attempt tracker keyed by IP / email. */
export class LoginLockout {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly threshold = LOGIN_LOCKOUT_THRESHOLD,
    private readonly windowMs = LOGIN_LOCKOUT_MS,
  ) {}

  private prune(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const next = (this.failures.get(key) || []).filter((ts) => ts >= cutoff);
    if (next.length) this.failures.set(key, next);
    else this.failures.delete(key);
    return next;
  }

  isLocked(...keys: string[]): boolean {
    const now = Date.now();
    return keys.some((key) => {
      if (!key) return false;
      return this.prune(key, now).length >= this.threshold;
    });
  }

  /** @returns true when this failure newly trips the lockout threshold. */
  recordFailure(...keys: string[]): boolean {
    const now = Date.now();
    let tripped = false;
    for (const key of keys) {
      if (!key) continue;
      const list = this.prune(key, now);
      list.push(now);
      this.failures.set(key, list);
      if (list.length === this.threshold) tripped = true;
    }
    return tripped;
  }

  clear(...keys: string[]): void {
    for (const key of keys) {
      if (key) this.failures.delete(key);
    }
  }
}
