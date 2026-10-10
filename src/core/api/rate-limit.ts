import { prisma } from "@/core/db/prisma";
import { AppError } from "@/core/errors";

/**
 * DB-backed rate limiter (P1-hardened): multi-instance safe on shared
 * PostgreSQL via a SINGLE atomic upsert statement (row lock serializes
 * concurrent checkers — no check-then-act race, no P2002 loser path).
 *
 * Exactly `limit` requests pass per window (memory path and DB path agree;
 * the pre-P1 DB path allowed `limit - 1` — off-by-one unified here and
 * documented in PROGRESS.md).
 *
 * Storage-failure policy (explicit per call, never silent):
 * - "memory-fallback" (default): per-process buckets keep a single instance
 *   protected when the database is unreachable. NOT a distributed limit:
 *   restarts clear it and each replica counts independently (documented).
 * - "fail-closed": sensitive routes (login/register brute-force shields)
 *   refuse with 503 instead of degrading. These routes need the database
 *   for authentication anyway, so fail-closed loses no availability while
 *   guaranteeing the brute-force shield never silently drops.
 */

export type RateLimitStoragePolicy = "memory-fallback" | "fail-closed";

export interface RateLimitDb {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface RateLimitOpts {
  onStorageFailure?: RateLimitStoragePolicy;
  /** Injected store (tests). Defaults to the shared Prisma client. */
  db?: RateLimitDb;
}

export class RateLimitStorageError extends AppError {
  constructor() {
    super("Rate limit storage unavailable — try again shortly", 503, "RATE_LIMIT_STORAGE_DOWN");
  }
}

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function limitExceeded(): never {
  throw new AppError("Too many requests", 429, "RATE_LIMITED");
}

export async function rateLimitDb(
  key: string,
  limit: number,
  windowMs: number,
  opts: RateLimitOpts = {}
): Promise<void> {
  const policy = opts.onStorageFailure ?? "memory-fallback";
  const db: RateLimitDb = opts.db ?? prisma;
  try {
    const resetAt = new Date(Date.now() + windowMs);
    const rows = await db.$queryRaw<Array<{ count: number | bigint | string }>>`
      INSERT INTO "RateLimitEntry" ("key", "count", "resetAt", "updatedAt")
      VALUES (${key}, 1, ${resetAt}, NOW())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimitEntry"."resetAt" < NOW() THEN 1 ELSE "RateLimitEntry"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimitEntry"."resetAt" < NOW() THEN ${resetAt} ELSE "RateLimitEntry"."resetAt" END,
        "updatedAt" = NOW()
      RETURNING "count"`;
    const count = Number(rows[0]?.count ?? 1);
    if (count > limit) limitExceeded();
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") throw err;
    if (policy === "fail-closed") throw new RateLimitStorageError();
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
