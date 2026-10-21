import http from "http";
import https from "https";

const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 45_000;
const SEND_RETRIES = 4;
export const VISA_OPENWA_SESSION_NAME = "visa";

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface OpenwaSession {
  id: string;
  name: string;
  status: string;
  phone?: string | null;
  pushName?: string | null;
  lastError?: string | null;
}

export interface OpenwaLinkResult {
  session: OpenwaSession;
  qrCode: string | null;
}

export function parseWhatsAppChatIds(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of String(value ?? "").split(/[\n,;]+/)) {
    const token = part.trim();
    if (!token) continue;
    const id = normalizeChatId(token);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function parseWhatsAppDestinations(value: unknown): string {
  return parseWhatsAppChatIds(value).join(",");
}

function normalizeChatId(token: string): string {
  if (token.includes("@")) {
    const id = token.replace(/\s+/g, "");
    if (!/^.+@(c\.us|g\.us|lid)$/i.test(id)) {
      throw new Error(`Invalid WhatsApp id: ${token}`);
    }
    return id;
  }
  const digits = token.replace(/\D/g, "");
  if (digits.length < 8) {
    throw new Error(`Invalid WhatsApp number: ${token}`);
  }
  return `${digits}@c.us`;
}

export function normalizeOpenwaBaseUrl(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OpenWA URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenWA URL must be http or https");
  }
  return raw;
}

export function isOpenwaSessionId(value: unknown): boolean {
  return SESSION_UUID.test(String(value ?? "").trim());
}

export function configuredOpenwaBaseUrl(): string {
  try {
    return normalizeOpenwaBaseUrl(
      process.env.OPENWA_BASE_URL || "http://openwa:2785",
    );
  } catch {
    return "";
  }
}

export function openwaConfigured(settings: {
  openwaSessionId: string;
  whatsappGatewayReady: boolean;
}): boolean {
  return !!(settings.whatsappGatewayReady && settings.openwaSessionId);
}

export class OpenwaClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
    },
  ) {}

  async listSessions(): Promise<OpenwaSession[]> {
    const data = await this.requestJson("GET", "/api/sessions");
    if (Array.isArray(data)) return data.map(toSession);
    if (data && Array.isArray((data as { sessions?: unknown }).sessions)) {
      return (data as { sessions: unknown[] }).sessions.map(toSession);
    }
    return [];
  }

  async getSession(id: string): Promise<OpenwaSession> {
    return toSession(await this.requestJson("GET", sessionPath(id)));
  }

  async createSession(name: string): Promise<OpenwaSession> {
    return toSession(
      await this.requestJson("POST", "/api/sessions", { name }, [200, 201]),
    );
  }

  async startSession(id: string): Promise<OpenwaSession> {
    return toSession(
      await this.requestJson(
        "POST",
        `${sessionPath(id)}/start`,
        undefined,
        [200],
        START_TIMEOUT_MS,
      ),
    );
  }

  async getQr(id: string): Promise<{ qrCode: string | null; status?: string }> {
    const data = (await this.requestJson("GET", `${sessionPath(id)}/qr`)) as {
      qrCode?: string;
      status?: string;
    };
    const qrCode =
      typeof data?.qrCode === "string" && data.qrCode.startsWith("data:image/")
        ? data.qrCode
        : null;
    return { qrCode, status: data?.status };
  }

  async requestJson(
    method: string,
    path: string,
    body?: unknown,
    ok: number[] = [200],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const { status, text } = await openwaRequest({
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      method,
      path,
      body,
      timeoutMs,
    });
    if (!ok.includes(status)) {
      throw new WhatsAppError(openwaErrorMessage(status, text), status);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new WhatsAppError(`OpenWA returned invalid JSON (${status})`, status);
    }
  }
}

export async function ensureOpenwaSession(
  client: OpenwaClient,
  preferredId?: string,
): Promise<OpenwaLinkResult> {
  const session = await resolveSession(client, preferredId);
  return snapshotSession(client, await maybeStart(client, session));
}

export async function readOpenwaSession(
  client: OpenwaClient,
  sessionId: string,
): Promise<OpenwaLinkResult> {
  if (!isOpenwaSessionId(sessionId)) {
    throw new WhatsAppError("OpenWA session id is missing or invalid");
  }
  return snapshotSession(client, await client.getSession(sessionId));
}

async function resolveSession(
  client: OpenwaClient,
  preferredId?: string,
): Promise<OpenwaSession> {
  if (isOpenwaSessionId(preferredId)) {
    try {
      return await client.getSession(preferredId!);
    } catch (error) {
      if (!(error instanceof WhatsAppError) || error.status !== 404) throw error;
    }
  }
  const existing = (await client.listSessions()).find(
    (session) => session.name === VISA_OPENWA_SESSION_NAME,
  );
  if (existing) return existing;
  try {
    return await client.createSession(VISA_OPENWA_SESSION_NAME);
  } catch (error) {
    if (!(error instanceof WhatsAppError) || error.status !== 409) throw error;
    const again = (await client.listSessions()).find(
      (session) => session.name === VISA_OPENWA_SESSION_NAME,
    );
    if (again) return again;
    throw error;
  }
}

async function maybeStart(
  client: OpenwaClient,
  session: OpenwaSession,
): Promise<OpenwaSession> {
  const status = session.status.toLowerCase();
  if (
    status === "ready" ||
    status === "qr_ready" ||
    status === "authenticating" ||
    status === "initializing" ||
    status === "action_required"
  ) {
    return session;
  }
  try {
    return await client.startSession(session.id);
  } catch (error) {
    if (!(error instanceof WhatsAppError) || error.status !== 400) throw error;
    return client.getSession(session.id);
  }
}

async function snapshotSession(
  client: OpenwaClient,
  session: OpenwaSession,
): Promise<OpenwaLinkResult> {
  const status = session.status.toLowerCase();
  if (status !== "qr_ready") {
    return { session, qrCode: null };
  }
  try {
    const qr = await client.getQr(session.id);
    return {
      session: { ...session, status: qr.status || session.status },
      qrCode: qr.qrCode,
    };
  } catch (error) {
    if (error instanceof WhatsAppError && error.status === 400) {
      return { session: await client.getSession(session.id), qrCode: null };
    }
    throw error;
  }
}

function sessionPath(id: string): string {
  return `/api/sessions/${encodeURIComponent(id)}`;
}

function toSession(raw: unknown): OpenwaSession {
  const row = (raw || {}) as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  if (!id) throw new WhatsAppError("OpenWA session is missing an id");
  return {
    id,
    name: String(row.name ?? ""),
    status: String(row.status ?? "created").toLowerCase(),
    phone: row.phone == null ? null : String(row.phone),
    pushName: row.pushName == null ? null : String(row.pushName),
    lastError: row.lastError == null ? null : String(row.lastError),
  };
}

function openwaErrorMessage(status: number, body: string): string {
  try {
    const data = JSON.parse(body) as { message?: string; error?: string };
    if (data?.message) return String(data.message);
    if (data?.error) return String(data.error);
  } catch {
    /* use fallback */
  }
  if (body) return `OpenWA HTTP ${status}: ${body.slice(0, 200)}`;
  return `OpenWA HTTP ${status}`;
}

export class WhatsAppService {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      sessionId: string;
    },
  ) {}

  async sendText(
    chatId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<void> {
    let lastError: WhatsAppError | undefined;
    for (let attempt = 1; attempt <= SEND_RETRIES; attempt++) {
      const { status, text: body } = await openwaRequest({
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        method: "POST",
        path: `${sessionPath(this.options.sessionId)}/messages/send-text`,
        body: { chatId, text },
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (status === 201 || status === 200) return;
      lastError = new WhatsAppError(openwaErrorMessage(status, body), status);
      if (
        attempt === SEND_RETRIES ||
        !isRetryableOpenwaSend(status, lastError.message)
      ) {
        throw refineOpenwaSendError(lastError);
      }
      await sleep(sendRetryDelayMs());
    }
    throw refineOpenwaSendError(lastError!);
  }

  async sendToMany(
    chatIds: string[],
    text: string,
    keyPrefix: string,
  ): Promise<void> {
    for (const chatId of chatIds) {
      await this.sendText(chatId, text, `${keyPrefix}:${chatId}`);
    }
  }
}

function sendRetryDelayMs(): number {
  const n = Number(process.env.OPENWA_SEND_RETRY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2_000;
}

function isRetryableOpenwaSend(status: number, message: string): boolean {
  if (status === 409 || status === 503) return true;
  return /not connected|not ready|reconnecting|page crashed/i.test(message);
}

function refineOpenwaSendError(error: WhatsAppError): WhatsAppError {
  if (/not connected|not ready/i.test(error.message)) {
    return new WhatsAppError(
      "WhatsApp is still connecting. Wait a few seconds and try again.",
      error.status,
    );
  }
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openwaRequest(options: {
  baseUrl: string;
  apiKey: string;
  method: string;
  path: string;
  body?: unknown;
  headers?: http.OutgoingHttpHeaders;
  timeoutMs?: number;
}): Promise<{ status: number; text: string }> {
  const url = new URL(options.path, `${options.baseUrl}/`);
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: http.OutgoingHttpHeaders = {
    "X-API-Key": options.apiKey,
    ...options.headers,
  };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      { method: options.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      req.destroy(new WhatsAppError("OpenWA request timed out"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
