import http from "http";
import https from "https";

const REQUEST_TIMEOUT_MS = 15_000;

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
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

export function openwaConfigured(settings: {
  openwaBaseUrl: string;
  openwaSessionId: string;
  hasOpenwaApiKey: boolean;
}): boolean {
  return !!(
    settings.openwaBaseUrl &&
    settings.openwaSessionId &&
    settings.hasOpenwaApiKey
  );
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
    const url = new URL(
      `/api/sessions/${encodeURIComponent(this.options.sessionId)}/messages/send-text`,
      `${this.options.baseUrl}/`,
    );
    const payload = JSON.stringify({ chatId, text });
    const { status, body } = await postJson(url, payload, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
      "X-API-Key": this.options.apiKey,
      "Idempotency-Key": idempotencyKey,
    });
    if (status === 201 || status === 200) return;
    let detail = `OpenWA HTTP ${status}`;
    try {
      const data = JSON.parse(body) as { message?: string; error?: string };
      if (data?.message) detail = String(data.message);
      else if (data?.error) detail = String(data.error);
    } catch {
      if (body) detail = `${detail}: ${body.slice(0, 200)}`;
    }
    throw new WhatsAppError(detail, status);
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

function postJson(
  url: URL,
  payload: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; body: string }> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      { method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new WhatsAppError("OpenWA request timed out"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
