import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/core/errors";
import {
  clearRateLimitMemory,
  rateLimitDb,
  rateLimitMemory,
  type RateLimitDb,
} from "@/core/api/rate-limit";

/**
 * Serialized fake of the Postgres atomic upsert: executes the whole
 * CASE-statement synchronously per call (row-lock semantics), with a yielded
 * microtask so Promise.all interleavings are realistic.
 */
function makeSerialFake(): RateLimitDb & { rows: Map<string, { count: number; resetAt: number }> } {
  const rows = new Map<string, { count: number; resetAt: number }>();
  return {
    rows,
    async $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
      void strings;
      await Promise.resolve();
      const key = String(values[0]);
      const resetAt = (values[1] as Date).getTime();
      const now = Date.now();
      const row = rows.get(key);
      let count: number;
      if (!row) {
        count = 1;
        rows.set(key, { count, resetAt });
      } else if (row.resetAt < now) {
        count = 1;
        rows.set(key, { count, resetAt });
      } else {
        count = row.count + 1;
        row.count = count;
      }
      return [{ count }] as unknown as T;
    },
  };
}

function failingDb(): RateLimitDb {
  return {
    async $queryRaw<T>(): Promise<T> {
      throw new Error("db-down");
    },
  };
}

beforeEach(() => {
  clearRateLimitMemory();
});

describe("P1 rate limiter — shared-store semantics", () => {
  it("allows exactly `limit` requests, then 429", async () => {
    const db = makeSerialFake();
    await rateLimitDb("k1", 3, 60_000, { db });
    await rateLimitDb("k1", 3, 60_000, { db });
    await rateLimitDb("k1", 3, 60_000, { db });
    await expect(rateLimitDb("k1", 3, 60_000, { db })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("concurrent checkers never exceed the limit (atomic statement)", async () => {
    const db = makeSerialFake();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rateLimitDb("hot-key", 5, 60_000, { db }).then(
          () => "pass" as const,
          (e: unknown) => (e instanceof AppError && e.statusCode === 429 ? "limited" as const : (() => { throw e; })())
        )
      )
    );
    expect(results.filter((r) => r === "pass")).toHaveLength(5);
    expect(results.filter((r) => r === "limited")).toHaveLength(15);
  });

  it("window expiry resets the budget", async () => {
    const db = makeSerialFake();
    await rateLimitDb("win", 1, 1, { db });
    await new Promise((r) => setTimeout(r, 10));
    await rateLimitDb("win", 1, 1, { db });
  });

  it("keys are isolated per client/route (multi-tenant)", async () => {
    const db = makeSerialFake();
    await rateLimitDb("ip-a:/api/auth/login", 1, 60_000, { db });
    await rateLimitDb("ip-b:/api/auth/login", 1, 60_000, { db });
    await expect(rateLimitDb("ip-a:/api/auth/login", 1, 60_000, { db })).rejects.toMatchObject({ statusCode: 429 });
    await expect(rateLimitDb("ip-b:/api/auth/login", 1, 60_000, { db })).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe("P1 rate limiter — storage-failure policy", () => {
  it("default memory-fallback still shields a single instance when the DB is down", async () => {
    await rateLimitDb("fb", 1, 60_000, { db: failingDb() });
    await expect(rateLimitDb("fb", 1, 60_000, { db: failingDb() })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("fail-closed refuses with 503 and never degrades silently", async () => {
    await expect(rateLimitDb("strict", 10, 60_000, { db: failingDb(), onStorageFailure: "fail-closed" })).rejects.toMatchObject({
      statusCode: 503,
      code: "RATE_LIMIT_STORAGE_DOWN",
    });
    // Memory buckets untouched: a direct memory check for the same key starts fresh.
    rateLimitMemory("strict", 10, 60_000);
  });

  it("memory fallback is process-local (restart clears it) — documented, not distributed", () => {
    rateLimitMemory("ephemeral", 1, 60_000);
    expect(() => rateLimitMemory("ephemeral", 1, 60_000)).toThrowError(/Too many requests/);
    clearRateLimitMemory();
    rateLimitMemory("ephemeral", 1, 60_000);
  });
});
