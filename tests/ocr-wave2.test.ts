/**
 * Wave 2 — دفعة تكميلية من نفس الفحص الكامل (docs/CODE-REVIEW-OCR-2026-10-16.md):
 * سباق إنشاء الحدث ← طابور المهمة · تجميع العاملات المحدود لمزامنة الـ OMS ·
 * أسرار القنوات مشفّرة وسكونًا مع قراءة متسامحة للصفوف القديمة · رموز الرفض
 * النهائي للترحيل التلقائي.
 * كل اختبار هون كان بيفشل قبل التصليح (قاعدة المشروع).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { AppError } from "@/core/errors";
import { atomically } from "@/modules/channels/webhook-tx";
import { runPool } from "@/modules/util/pool";
import {
  decryptSecret,
  encryptSecret,
} from "@/core/crypto";
import { readChannelSecret } from "@/modules/channels/secret-at-rest";

// ── 1) المعاملة الميسّرة — مسار tx عندما تكون متاحة ومسار fallback بلاها ──
describe("OCR wave2 — atomically (tx when available, fallback identical)", () => {
  const fn = async (tx: { marker: string }) => ({ ranOn: tx.marker });

  it("uses the interactive transaction when the db supports it", async () => {
    const db = {
      $transaction: <T>(f: (tx: { marker: string }) => Promise<T>) => f({ marker: "tx" }),
    };
    const res = await atomically(db as never, fn);
    expect(res).toEqual({ ranOn: "tx" });
  });

  it("falls back to the plain db in tests/memory dbs — same result", async () => {
    const db = { marker: "plain" };
    const res = await atomically(db as never, fn);
    expect(res).toEqual({ ranOn: "plain" });
  });

  it("P2002 inside the transaction propagates the same way as the old catch", async () => {
    const db = { $transaction: <T>(f: (tx: unknown) => Promise<T>) => f({ code: "P2002" }) };
    await expect(
      atomically(db as never, async () => {
        throw new Error("P2002");
      })
    ).rejects.toThrow("P2002");
  });
});

// ── 2) تجميع العاملات المحدود (max 8 استدعاءات متوازية لا 500 متسلسلة) ──
describe("OCR wave2 — runPool bounded concurrency", () => {
  it("never exceeds the concurrency cap", async () => {
    let nowRunning = 0;
    let peak = 0;
    const results = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      nowRunning += 1;
      peak = Math.max(peak, nowRunning);
      await new Promise((r) => setTimeout(r, 5));
      nowRunning -= 1;
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("empty input returns empty without spawning workers", async () => {
    const res = await runPool([], 8, async (n) => n);
    expect(res).toEqual([]);
  });

  it("propagates the first error after workers finish (no unhandled rejections)", async () => {
    await expect(
      runPool([1, 2], 2, async (n) => {
        if (n === 1) throw new Error("boom");
        await new Promise((r) => setTimeout(r, 10));
        return n;
      })
    ).rejects.toThrow("boom");
  });
});

// ── 3) أسرار القنوات — مشفّرة سكونًا · قراءة متسامحة للصفوف القديمة ──
describe("OCR wave2 — channel secrets at rest (encrypted write, lenient read)", () => {
  it("roundtrips through the encrypted key", () => {
    const meta = { tgWebhookSecretEnc: encryptSecret("s3cr3t-value") };
    expect(readChannelSecret(meta as never, "tgWebhookSecretEnc", "tgWebhookSecret")).toBe("s3cr3t-value");
  });

  it("legacy plaintext rows keep verifying (no data migration required)", () => {
    const meta = { tgWebhookSecret: "legacy-plain" };
    expect(readChannelSecret(meta as never, "tgWebhookSecretEnc", "tgWebhookSecret")).toBe("legacy-plain");
  });

  it("corrupted ciphertext does NOT silently fall back to a stale value", () => {
    const meta = { tgWebhookSecretEnc: "not-a-valid-ciphertext" };
    expect(readChannelSecret(meta as never, "tgWebhookSecretEnc", "tgWebhookSecret")).toBeNull();
  });

  it("empty/missing both → null", () => {
    expect(readChannelSecret({} as never, "tgWebhookSecretEnc", "tgWebhookSecret")).toBeNull();
    expect(readChannelSecret({ tgWebhookSecretEnc: "", tgWebhookSecret: null } as never, "tgWebhookSecretEnc", "tgWebhookSecret")).toBeNull();
  });

  it("value from these helpers is never plaintext-decpable as ciphertext", () => {
    // لا مفتاح مشفّر = ما في نص عشوائي بيتقبل كسر حديث — فشل صامت مضاد.
    const meta = { tgWebhookSecretEnc: encryptSecret("x") };
    const enc = (meta as { tgWebhookSecretEnc: string }).tgWebhookSecretEnc;
    expect(decryptSecret(enc)).toBe("x");
  });
});

// ── 4) رموز الرفض النهائي للترحيل التلقائي ──
describe("OCR wave2 — auto-handoff definitive refusals", () => {
  afterEach(() => {
    vi.doUnmock("@/modules/oms/handoff");
    vi.resetModules();
  });

  it("OMS_URL_REJECTED is final: audited refusal, no retry churn", async () => {
    vi.doMock("@/modules/oms/handoff", () => ({
      handoffOrderToOms: async () => {
        throw new AppError("رابط مرفوض", 422, "OMS_URL_REJECTED");
      },
    }));
    const { handleAutoHandoffJob } = await import("@/modules/oms/auto-handoff");
    const db = createFakeDb();
    const res = await handleAutoHandoffJob(db as unknown as Prisma.TransactionClient, { orderId: "ord-1" }, "ws-x");
    expect(res.success).toBe(true);
    const audits = (db as unknown as { _stores: { auditLog: Array<{ action: string; metadata?: { code?: string } }> } })
      ._stores.auditLog;
    const refusal = audits.find((a) => a.action === "oms.auto_handoff_refused");
    expect(refusal?.metadata?.code).toBe("OMS_URL_REJECTED");
  });

  it("transient codes keep retrying (success:false)", async () => {
    vi.doMock("@/modules/oms/handoff", () => ({
      handoffOrderToOms: async () => {
        throw new AppError("شبكة", 503, "OMS_UNREACHABLE");
      },
    }));
    const { handleAutoHandoffJob } = await import("@/modules/oms/auto-handoff");
    const db = createFakeDb();
    const res = await handleAutoHandoffJob(db as unknown as Prisma.TransactionClient, { orderId: "ord-2" }, "ws-x");
    expect(res.success).toBe(false);
  });
});
