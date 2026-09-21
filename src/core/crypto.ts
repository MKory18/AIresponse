import crypto from "node:crypto";
import { getEnv } from "./env";
import { EncryptionError } from "./errors";

const ALGORITHM = "aes-256-gcm";

function deriveKey(): Buffer {
  const env = getEnv();
  // Accept hex (64 chars) or derive from arbitrary string via SHA-256.
  if (/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) {
    return Buffer.from(env.ENCRYPTION_KEY, "hex");
  }
  return crypto.createHash("sha256").update(env.ENCRYPTION_KEY).digest();
}

/** Encrypts a secret at rest. Output: base64(iv).base64(tag).base64(ciphertext) */
export function encryptSecret(plaintext: string): string {
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
  } catch (err) {
    throw new EncryptionError("Failed to encrypt secret");
  }
}

export function decryptSecret(payload: string): string {
  try {
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed payload");
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      deriveKey(),
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new EncryptionError("Failed to decrypt secret");
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}
