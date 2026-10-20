import crypto from "crypto";
import fs from "fs";
import path from "path";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Authenticated encryption for secrets stored in SQLite.
 *
 * The 32-byte master key is read from VISA_MASTER_KEY_FILE, or
 * secrets/master.key by default, and is never stored in the database. Every value is
 * bound to a context string (eg. "profile:3:visa_password") through GCM's
 * additional authenticated data, so a ciphertext copied into another row or
 * column fails to decrypt instead of silently yielding someone else's secret.
 */
export class SecretBox {
  private readonly key: Buffer;

  private constructor(key: Buffer) {
    this.key = key;
  }

  static resolveKeyPath(): string {
    return process.env.VISA_MASTER_KEY_FILE || path.resolve("secrets/master.key");
  }

  static fromEnvironment(): SecretBox {
    const file = SecretBox.resolveKeyPath();
    if (!fs.existsSync(file)) {
      throw Error(
        `${file} not found. Generate a key with: node build/server/cli.js generate-key`,
      );
    }

    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) {
      console.warn(
        `Warning: ${file} is readable by other users. Run: chmod 600 ${file}`,
      );
    }

    const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) {
      throw Error(
        `${file} must contain exactly 32 base64-encoded bytes (got ${key.length})`,
      );
    }

    return new SecretBox(key);
  }

  encrypt(plaintext: string, context: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    return `${VERSION}:${payload.toString("base64")}`;
  }

  decrypt(value: string, context: string): string {
    const [version, encoded] = value.split(":", 2);
    if (version !== VERSION || !encoded) {
      throw Error(`Unsupported secret format for ${context}`);
    }

    const payload = Buffer.from(encoded, "base64");
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);

    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw Error(
        `Unable to decrypt ${context}: wrong master key or tampered data`,
      );
    }
  }
}
