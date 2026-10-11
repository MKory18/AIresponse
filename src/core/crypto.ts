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
    throw new EncryptionError("Failed to encrypt secret", safeCause(err));
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

/**
 * P1: safe failure cause. Crypto must never leak key material, but a bare
 * "Failed to encrypt" hid a trivial misconfiguration (truncated
 * ENCRYPTION_KEY after dotenv `#` comment parsing) for a full debug session.
 * Only the whitelisted env-validation prefix (field names + constraints, no
 * values) is propagated; everything else stays opaque.
 */
function safeCause(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith("Invalid environment configuration") ? msg : undefined;
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

/** Signs a payload with HMAC-SHA256 using a derived key from ENCRYPTION_KEY. */
export function signPayload(payload: Record<string, unknown>): string {
  const key = deriveKey();
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  const hmac = crypto.createHmac("sha256", key).update(data).digest();
  const encodedData = data.toString("base64url");
  const encodedSig = hmac.toString("base64url");
  return `${encodedData}.${encodedSig}`;
}

/** Verifies a signed payload and returns the decoded payload if valid. */
export function verifyPayload(token: string, maxAgeSeconds?: number): Record<string, unknown> | null {
  const key = deriveKey();
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  const encodedData = token.slice(0, dotIndex);
  const encodedSig = token.slice(dotIndex + 1);
  let data: Buffer;
  try {
    data = Buffer.from(encodedData, "base64url");
  } catch {
    return null;
  }
  const expectedSig = crypto.createHmac("sha256", key).update(data).digest();
  const providedSig = Buffer.from(encodedSig, "base64url");
  // P12: ترميز قانوني فقط — فك base64url متسامح (آخر حرف بأكتر من شكل بيعطي
  // نفس البايتات)، فنفس التوكن كان يقبل أكتر من كتابة (تلاعب بالتوقيع).
  if (data.toString("base64url") !== encodedData || providedSig.toString("base64url") !== encodedSig) return null;
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  // Always check exp if present in payload (absolute expiration)
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp !== 0 && Math.floor(Date.now() / 1000) > exp) return null;
  // Optional: additional sliding window check
  if (maxAgeSeconds !== undefined) {
    const iat = typeof payload.iat === "number" ? payload.iat : 0;
    if (iat !== 0 && Math.floor(Date.now() / 1000) - iat > maxAgeSeconds) return null;
  }
  return payload;
}
