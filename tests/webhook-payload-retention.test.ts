import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  purgeOldWebhookPayloads,
  retentionDays,
  DEFAULT_RETENTION_DAYS,
} from "@/modules/channels/webhook-retention";
import { resetIntegrationScheduler, runIntegrationScheduler } from "@/modules/integrations/scheduler";

/**
 * مدة الاحتفاظ بحمولة أحداث القنوات الخام. الحمولة فيها رقم الزبون ونص
 * رسالته ورمز نقرة الإعلان، وكانت تنحفظ بلا مدة — يعني للأبد.
 * الصف نفسه ما بينحذف: عدم تكرار الأحداث معتمد على (source, externalEventId).
 */

type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
const NOW = new Date("2026-10-11T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

/** حمولة ميتا الخام كما بتوصل — رقم ونص ورمز نقرة. */
const RAW = {
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: "963933000111", profile: { name: "أبو محمد" } }],
            messages: [
              {
                from: "963933000111",
                text: { body: "بدي كريم للبشرة" },
                referral: { ctwa_clid: "ARAbCdEf123", source_id: "120209" },
              },
            ],
          },
        },
      ],
    },
  ],
};

async function seedEvent(opts: {
  id: string;
  createdAt: Date;
  processedAt?: Date | null;
  error?: string | null;
  payloadPurgedAt?: Date | null;
}) {
  return db.webhookEvent.create({
    data: {
      workspaceId: "ws-1",
      channelType: "WHATSAPP",
      source: "whatsapp",
      externalEventId: opts.id,
      payload: RAW,
      createdAt: opts.createdAt,
      processedAt: opts.processedAt ?? null,
      error: opts.error ?? null,
      payloadPurgedAt: opts.payloadPurgedAt ?? null,
    },
  } as never);
}

const row = (externalEventId: string) =>
  (db._stores.webhookEvent as Record<string, unknown>[]).find((e) => e.externalEventId === externalEventId)!;

/** هل الحمولة لسا فيها بيانات الزبون؟ */
const leaks = (externalEventId: string) => {
  const blob = JSON.stringify(row(externalEventId).payload ?? {});
  return blob.includes("963933000111") || blob.includes("بدي كريم") || blob.includes("ARAbCdEf123");
};

let prev: string | undefined;
beforeEach(() => {
  db = createFakeDb();
  prev = process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS;
  delete process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS;
});
afterEach(() => {
  if (prev === undefined) delete process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS;
  else process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS = prev;
});

describe("مدة الاحتفاظ — المدة من الإعداد", () => {
  it("بلا إعداد = 30 يوم · قيمة غلط = 30 يوم · `0` = مطفي", async () => {
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS = "abc";
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS = "-5";
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS = "7";
    expect(retentionDays()).toBe(7);
    process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS = "0";
    expect(retentionDays()).toBe(0);
  });

  it("`0` = ولا صف بينلمس (الحمولة تبقى بلا مدة — قرار صريح)", async () => {
    process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS = "0";
    await seedEvent({ id: "ev-old", createdAt: daysAgo(400), processedAt: daysAgo(400) });
    const res = await purgeOldWebhookPayloads(db as Db, NOW);
    expect(res).toMatchObject({ purged: 0, disabled: true });
    expect(leaks("ev-old")).toBe(true);
  });
});

describe("مدة الاحتفاظ — الكنس", () => {
  it("حدث معالَج أقدم من المدة: الحمولة تُفرّغ والصف يبقى", async () => {
    await seedEvent({ id: "ev-1", createdAt: daysAgo(45), processedAt: daysAgo(45) });
    expect(leaks("ev-1")).toBe(true);
    const res = await purgeOldWebhookPayloads(db as Db, NOW);
    expect(res.purged).toBe(1);
    // الصف موجود — عدم تكرار الأحداث معتمد عليه.
    expect((db._stores.webhookEvent as unknown[]).length).toBe(1);
    expect(row("ev-1").externalEventId).toBe("ev-1");
    expect(row("ev-1").payload).toEqual({ purged: true });
    expect(row("ev-1").payloadPurgedAt).toEqual(NOW);
    expect(leaks("ev-1")).toBe(false);
  });

  it("الصف المُفرَّغ يضل يمنع إعادة نفس الحدث (عدم التكرار ما بينكسر)", async () => {
    await seedEvent({ id: "ev-dup", createdAt: daysAgo(60), processedAt: daysAgo(60) });
    await purgeOldWebhookPayloads(db as Db, NOW);
    await expect(
      db.webhookEvent.create({
        data: { workspaceId: "ws-1", channelType: "WHATSAPP", source: "whatsapp", externalEventId: "ev-dup", payload: RAW },
      } as never)
    ).rejects.toBeTruthy();
  });

  it("حدث جوّا المدة: ما بينلمس", async () => {
    await seedEvent({ id: "ev-fresh", createdAt: daysAgo(3), processedAt: daysAgo(3) });
    expect((await purgeOldWebhookPayloads(db as Db, NOW)).purged).toBe(0);
    expect(leaks("ev-fresh")).toBe(true);
    expect(row("ev-fresh").payloadPurgedAt).toBeNull();
  });

  it("حدث لسا عم ينعالج (بلا معالجة وبلا خطأ): الحمولة تبقى حتى الإعادة تشتغل", async () => {
    await seedEvent({ id: "ev-pending", createdAt: daysAgo(90), processedAt: null, error: null });
    expect((await purgeOldWebhookPayloads(db as Db, NOW)).purged).toBe(0);
    expect(leaks("ev-pending")).toBe(true);
  });

  it("حدث فشل نهائيًا وقديم: الحمولة تُفرّغ (ما عاد في إعادة)", async () => {
    await seedEvent({ id: "ev-failed", createdAt: daysAgo(90), processedAt: null, error: "HMAC mismatch" });
    expect((await purgeOldWebhookPayloads(db as Db, NOW)).purged).toBe(1);
    expect(leaks("ev-failed")).toBe(false);
    // الخطأ يبقى للتشخيص — الي بينشال المحتوى بس.
    expect(row("ev-failed").error).toBe("HMAC mismatch");
  });

  it("التشغيل مرتين: الكنس ما يعيد نفس الصف", async () => {
    await seedEvent({ id: "ev-a", createdAt: daysAgo(40), processedAt: daysAgo(40) });
    await seedEvent({ id: "ev-b", createdAt: daysAgo(41), processedAt: daysAgo(41) });
    expect((await purgeOldWebhookPayloads(db as Db, NOW)).purged).toBe(2);
    expect((await purgeOldWebhookPayloads(db as Db, NOW)).purged).toBe(0);
  });

  it("مدة مخصّصة (7 أيام) بتنطبق", async () => {
    process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS = "7";
    await seedEvent({ id: "ev-10d", createdAt: daysAgo(10), processedAt: daysAgo(10) });
    await seedEvent({ id: "ev-2d", createdAt: daysAgo(2), processedAt: daysAgo(2) });
    expect((await purgeOldWebhookPayloads(db as Db, NOW)).purged).toBe(1);
    expect(leaks("ev-10d")).toBe(false);
    expect(leaks("ev-2d")).toBe(true);
  });

  it("المجدول الساعي بيشغّل الكنس فعلًا (مش وحدة ميتة)", async () => {
    resetIntegrationScheduler();
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    await seedEvent({ id: "ev-sched", createdAt: daysAgo(99), processedAt: daysAgo(99) });
    await runIntegrationScheduler(db as Db, NOW);
    expect(leaks("ev-sched")).toBe(false);
    expect(row("ev-sched").payloadPurgedAt).toEqual(NOW);
    vi.unstubAllGlobals();
  });

  it("الكنس محدود بكل دورة — الباقي بالدورة الي بعدها", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedEvent({ id: `ev-m${i}`, createdAt: daysAgo(50 + i), processedAt: daysAgo(50 + i) });
    }
    expect((await purgeOldWebhookPayloads(db as Db, NOW, 2)).purged).toBe(2);
    expect((await purgeOldWebhookPayloads(db as Db, NOW, 2)).purged).toBe(2);
    expect((await purgeOldWebhookPayloads(db as Db, NOW, 2)).purged).toBe(1);
    expect((await purgeOldWebhookPayloads(db as Db, NOW, 2)).purged).toBe(0);
  });
});
