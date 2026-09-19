import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secrets at rest — Slack client secrets and bot tokens, MCP OAuth tokens,
 * the Stripe webhook secret — are encrypted with AES-256-GCM under a single
 * key from `ENCRYPTION_KEY`. The database is a third party's, and a leaked
 * dump should not hand over every workspace's credentials.
 *
 * Stored form: `enc:v1:<iv>.<ciphertext>.<tag>`, each part base64url. The
 * prefix makes an unencrypted value recognisable, so a plaintext column can
 * never be mistaken for an encrypted one (or the other way round).
 */
const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64(iv)}.${b64(ciphertext)}.${b64(tag)}`;
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    throw new Error("Refusing to read a secret that is not encrypted.");
  }
  const [iv, ciphertext, tag] = stored.slice(PREFIX.length).split(".");
  if (!iv || !ciphertext || !tag) {
    throw new Error("Stored secret is malformed.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isEncrypted(value: string) {
  return value.startsWith(PREFIX);
}

/** `encryptSecret` for nullable columns. */
export function encryptOptional(plain: string | null | undefined) {
  return plain == null ? null : encryptSecret(plain);
}

export function decryptOptional(stored: string | null | undefined) {
  return stored == null ? null : decryptSecret(stored);
}

let cachedKey: Buffer | null = null;

/**
 * 32 bytes, given as 64 hex characters or as base64/base64url. Read lazily so
 * importing this module never throws; the first secret written or read does.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw === "[sensitive]") {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` " +
        "and add it to the environment; secrets can't be stored without it.",
    );
  }

  const decoded = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must be ${KEY_BYTES} bytes (64 hex characters or base64), ` +
        `got ${decoded.length}.`,
    );
  }

  cachedKey = decoded;
  return decoded;
}

function b64(bytes: Buffer) {
  return bytes.toString("base64url");
}
