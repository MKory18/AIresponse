import { prisma } from "@/core/db/prisma";
import { AppError } from "@/core/errors";

/**
 * DB-backed rate limiter (سيستم 7 — B1): multi-instance safe, on the database
 * pattern (no Redis). Falls back to in-memory buckets only when the database
 * is unreachable, so the API never hard-fails on limiter errors.
 */

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function limitExceeded(): never {
  throw new AppError("Too many requests", 429, "RATE_LIMITED");
}

export async function rateLimitDb(key: string, limit: number, windowMs: number): Promise<void> {
  try {
    const now = new Date();
    const entry = await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count: 1, resetAt: new Date(now.getTime() + windowMs) },
      update: {},
    });
    if (entry.resetAt < now) {
      await prisma.rateLimitEntry.update({
        where: { key },
        data: { count: 1, resetAt: new Date(now.getTime() + windowMs) },
      });
      return;
    }
    if (entry.count >= limit) limitExceeded();
    await prisma.rateLimitEntry.update({ where: { key }, data: { count: { increment: 1 } } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    // DB unavailable → in-memory fallback (single instance still protected).
    rateLimitMemory(key, limit, windowMs);
  }
}

export function rateLimitMemory(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) limitExceeded();
}

/** Test helper: clear in-memory buckets. */
export function clearRateLimitMemory(): void {
  memoryBuckets.clear();
}
