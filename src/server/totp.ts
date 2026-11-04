import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 4648 base32 without padding. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  if (!cleaned || /[^A-Z2-7]/.test(cleaned)) {
    throw new Error("Invalid base32 secret");
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20 random bytes → 32-char base32 secret (standard authenticator size). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const truncated = code % 10 ** DIGITS;
  return String(truncated).padStart(DIGITS, "0");
}

export function currentTotpCounter(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Verify a user-entered code against the secret.
 * Allows ±window steps (default 1 = current ± 30s).
 * Returns the matching counter, or null.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options?: { window?: number; nowMs?: number },
): number | null {
  const normalized = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const window = options?.window ?? 1;
  const center = currentTotpCounter(options?.nowMs);
  for (let delta = -window; delta <= window; delta++) {
    const counter = center + delta;
    const expected = totpAt(secretBase32, counter);
    const a = Buffer.from(expected);
    const b = Buffer.from(normalized);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return counter;
    }
  }
  return null;
}

export function otpauthUri(options: {
  secret: string;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = options.issuer || "Visa Appointment Finder";
  const label = `${issuer}:${options.accountName}`;
  const params = new URLSearchParams({
    secret: options.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
