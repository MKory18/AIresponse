/**
 * الحزمة 1.3 — تشغيل القارئ بوضع الظل (02-ORDER-FLOW §8.1–8.2 · §16: 15 · 16 · 17).
 * مزوّد وهمي · قاعدة بالذاكرة · ولا شبكة.
 *
 * القاعدة الأساسية: بوضع الظل القارئ بيحفظ `ConversationReading` وبس —
 * ولا طلب ولا رسالة ولا أي تغيير بمسار الرد. وبوضع `LEGACY_DRAFT` ولا مهمة بتنصف.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import type { AIProvider, StructuredRequest } from "@/modules/ai/provider";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { JOB_TYPES } from "@/modules/jobs/service";
import { READ_DEBOUNCE_MS, scheduleConversationRead } from "@/modules/orders/reader/schedule";
import { shouldReadConversation, hasPhoneCandidate } from "@/modules/orders/reader/filter";
import { handleReadConversationJob, DEFER_FOR_PENDING_REPLY_MS } from "@/modules/orders/reader/service";
import { orderReadingSchema } from "@/modules/orders/reader/schema";

type Db = Prisma.TransactionClient;
const WS = "ws-reader";
const AGENT = { userId: "agent-1", workspaceId: WS };

let db: ReturnType<typeof createFakeDb>;
let conversationId: string;
let tick = 0;

function fakeProvider(failTimes = 0) {
  const calls: { system: string; user: string }[] = [];
  let failures = failTimes;
  const reading = orderReadingSchema.parse({
    intent: "ORDERING",
    relation: "NEW",
    items: [{ productRef: "ماء الكمأ", quantity: 2, evidence: ["m1"] }],
    customer: { name: null, phone: "0964123348", altPhone: null, city: "درعا", address: "شارع (أ)", evidence: { phone: ["m2"], address: ["m2"] } },
    agreement: { state: "EXPLICIT", evidence: ["m2"] },
    cancelRequested: false,
    notes: null,
    openQuestions: [],
    aiClaimedConfirmed: false,
    needsHuman: { value: false, reason: null },
    memories: [],
    confidence: 0.9,
  });
  const provider: AIProvider & { calls: typeof calls } = {
    name: "fake",
    delivery: "local",
    calls,
    async generateText() {
      throw new Error("generateText not expected");
    },
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls.push({ system: req.system, user: req.user });
      if (failures > 0) {
        failures -= 1;
        throw new Error("PROVIDER_DOWN");
      }
      const v = req.validate(reading);
      if (!v.ok) throw new Error(`invalid: ${v.error}`);
      return { value: v.value, text: "{}", promptTokens: 10, completionTokens: 10, latencyMs: 5 };
    },
  };
  return provider;
}

async function setMode(mode: "LEGACY_DRAFT" | "READER_SHADOW" | "READER") {
  await db.workspace.update({ where: { id: WS }, data: { integrationSettings: { orderMode: mode } } } as never);
}

async function say(senderType: "CUSTOMER" | "AI" | "HUMAN", text: string, extra: Record<string, unknown> = {}) {
  tick += 1;
  const m = await db.message.create({
    data: {
      conversationId,
      workspaceId: WS,
      senderType,
      direction: senderType === "CUSTOMER" ? "INBOUND" : "OUTBOUND",
      type: "TEXT",
      text,
      createdAt: new Date(Date.UTC(2026, 10, 16, 22, 0, tick)),
      ...extra,
    },
  } as never);
  return m.id as string;
}

const readingRow = async () => (await db._stores.conversationReading.find((r) => r.conversationId === conversationId)) as Record<string, unknown> | undefined;

beforeEach(async () => {
  db = createFakeDb();
  tick = 0;
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  await createProduct(db as Db, AGENT, { name: "ماء الكمأ", sku: "TW-500", price: 15, currency: "USD" });
  await db.channel.create({ data: { id: "ch-1", workspaceId: WS, type: "FACEBOOK", name: "كهربا", market: "SY" } } as never);
  const customer = await db.customer.create({ data: { workspaceId: WS, name: "أحمد", phone: null, status: "INTERESTED" } } as never);
  const conv = await db.conversation.create({ data: { workspaceId: WS, customerId: customer.id, channelId: "ch-1", channelConversationId: "fb-1" } } as never);
  conversationId = conv.id;
});

describe("الجدولة", () => {
  it("LEGACY_DRAFT (الافتراضي) = ولا مهمة بتنصف", async () => {
    const id = await say("CUSTOMER", "مرحبا");
    const r = await scheduleConversationRead(db as Db, { workspaceId: WS, conversationId, messageId: id });
    expect(r).toEqual({ scheduled: false, reason: "LEGACY_DRAFT" });
    expect(db._stores.backgroundJob.filter((j) => j.type === "read_conversation")).toHaveLength(0);
  });

  it("READER_SHADOW: مهمة مؤجّلة 45 ثانية بمفتاح الرسالة، ونفس الرسالة ما بتتكرر", async () => {
    await setMode("READER_SHADOW");
    const id = await say("CUSTOMER", "مرحبا");
    const now = new Date("2026-11-16T22:00:00Z");
    const a = await scheduleConversationRead(db as Db, { workspaceId: WS, conversationId, messageId: id, now });
    const b = await scheduleConversationRead(db as Db, { workspaceId: WS, conversationId, messageId: id, now });
    expect(a.scheduled).toBe(true);
    expect(b.scheduled).toBe(true);
    const jobs = db._stores.backgroundJob.filter((j) => j.type === "read_conversation");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotencyKey).toBe(`read:${WS}:${conversationId}:${id}`);
    expect(new Date(jobs[0].runAfter as Date).getTime()).toBe(now.getTime() + READ_DEBOUNCE_MS);
    expect(READ_DEBOUNCE_MS).toBe(45_000);
  });

  it("READER بنفس القاعدة، و`read_conversation` مسجّل بأنواع المهام والمعالجات", () => {
    expect(JOB_TYPES).toContain("read_conversation");
    expect(readFileSync("src/modules/jobs/handlers.ts", "utf8")).toContain("read_conversation:");
  });

  it("مسارا الإدخال (رسالة العميل ورد الموظف) بيستدعوا الجدولة بلا ما يوقفوا شي", () => {
    const inbound = readFileSync("src/modules/conversations/inbound.ts", "utf8");
    const outbound = readFileSync("src/modules/channels/outbound.ts", "utf8");
    expect(inbound).toContain("scheduleConversationRead");
    expect(outbound).toContain("scheduleConversationRead");
    expect(inbound).toMatch(/catch \(err\) \{\s*childLogger\("pipeline"\)\.warn\(\{ err, messageId: message\.id \}, "read_schedule_failed"\)/);
  });
});

describe("الفلتر ببلاش", () => {
  const cust = (text: string) => ({ senderType: "CUSTOMER" as const, text });
  const names = ["ماء الكمأ", "كريم حرير"];

  it("دردشة عادية ← ما بتنقرأ", () => {
    const d = shouldReadConversation({ messages: [cust("مرحبا"), cust("كيفكم")], productNames: names, hasOpenOrder: false });
    expect(d).toEqual({ read: false, reason: "NOTHING_ORDER_LIKE" });
  });
  it("رقم هاتف (حتى بأرقام هندية وفراغات) ← بتنقرأ", () => {
    expect(hasPhoneCandidate("رقمي ٠٩٦٤ ١٢٣ ٣٤٨")).toBe(true);
    expect(hasPhoneCandidate("عندي 3 أولاد")).toBe(false);
    expect(shouldReadConversation({ messages: [cust("0964123348")], productNames: names, hasOpenOrder: false }).read).toBe(true);
  });
  it("اسم منتج من الكتالوج ← بتنقرأ · اسم من برّا الكتالوج لا", () => {
    expect(shouldReadConversation({ messages: [cust("بدي ماء الكمأ")], productNames: names, hasOpenOrder: false })).toEqual({ read: true, reason: "PRODUCT" });
    expect(shouldReadConversation({ messages: [cust("بدي سيارة")], productNames: names, hasOpenOrder: false }).read).toBe(false);
  });
  it("كلمة إلغاء أو تعديل ← بتنقرأ", () => {
    expect(shouldReadConversation({ messages: [cust("بدي ألغي")], productNames: [], hasOpenOrder: false })).toEqual({ read: true, reason: "CANCEL_OR_AMEND" });
  });
  it("طلب مفتوح ← بتنقرأ دايمًا · والملاحظات والرسائل المحذوفة ما بتحسب", () => {
    expect(shouldReadConversation({ messages: [cust("شكرا")], productNames: names, hasOpenOrder: true })).toEqual({ read: true, reason: "OPEN_ORDER" });
    const d = shouldReadConversation({
      messages: [{ senderType: "CUSTOMER", text: "0964123348", isNote: true }, { senderType: "CUSTOMER", text: "0964123348", deletedAt: new Date() }],
      productNames: names,
      hasOpenOrder: false,
    });
    expect(d.read).toBe(false);
  });
});

describe("المعالج — بوضع الظل", () => {
  it("الـ debounce: 3 رسائل ← قراءة وحدة، والمهام القديمة بتطلع بلا عمل", async () => {
    await setMode("READER_SHADOW");
    const m1 = await say("CUSTOMER", "بدي ماء الكمأ");
    const m2 = await say("CUSTOMER", "2 حبة");
    const m3 = await say("CUSTOMER", "0964123348 درعا شارع (أ)");
    const provider = fakeProvider();
    const r1 = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m1 }, WS, { provider });
    const r2 = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m2 }, WS, { provider });
    expect(r1.outcome).toBe("STALE_JOB");
    expect(r2.outcome).toBe("STALE_JOB");
    expect(provider.calls).toHaveLength(0);
    const r3 = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m3 }, WS, { provider });
    expect(r3).toMatchObject({ success: true, outcome: "READ" });
    expect(provider.calls).toHaveLength(1);
    const row = (await readingRow()) as { stage: string; status: string; readThroughMessageId: string; version: number };
    expect(row.status).toBe("DONE");
    expect(row.readThroughMessageId).toBe(m3);
    expect(row.version).toBe(1);
    expect(row.stage).toBe("COMPLETE");
  });

  it("سيناريو 15 — الظل: ولا طلب ولا مسودة ولا رسالة صادرة، والقراءة بس", async () => {
    await setMode("READER_SHADOW");
    await say("CUSTOMER", "بدي ماء الكمأ");
    const last = await say("CUSTOMER", "2 حبة 0964123348 درعا شارع (أ) أكيد ثبّتوا");
    const before = { orders: db._stores.order.length, drafts: db._stores.orderDraft.length, messages: db._stores.message.length };
    const provider = fakeProvider();
    const r = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: last }, WS, { provider });
    expect(r.outcome).toBe("READ");
    expect(db._stores.order.length).toBe(before.orders);
    expect(db._stores.orderDraft.length).toBe(before.drafts);
    expect(db._stores.message.length).toBe(before.messages);
    expect(db._stores.conversationReading).toHaveLength(1);
    expect(db._stores.aIUsageLog.some((u) => u.purpose === "ORDER_READ" && u.promptVersion === "reader_v1")).toBe(true);
  });

  it("الفلتر: دردشة بلا شي يشبه الطلب ← مرحلة NONE بلا نداء", async () => {
    await setMode("READER_SHADOW");
    const m = await say("CUSTOMER", "السلام عليكم");
    const provider = fakeProvider();
    const r = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider });
    expect(r.outcome).toBe("FILTERED_NONE");
    expect(provider.calls).toHaveLength(0);
    expect(((await readingRow()) as { stage: string; status: string }).stage).toBe("NONE");
  });

  it("رد الوكيل على آخر رسالة لسا شغّال ← تأجيل 20 ثانية (وبعد دقيقتين بنقرأ بدونه)", async () => {
    await setMode("READER_SHADOW");
    const m = await say("CUSTOMER", "بدي ماء الكمأ 0964123348");
    const now = new Date("2026-11-16T22:10:00Z");
    await db.backgroundJob.create({
      data: { workspaceId: WS, type: "process_ai_message", status: "PROCESSING", payload: {}, idempotencyKey: `ai:${m}`, createdAt: new Date(now.getTime() - 5_000) },
    } as never);
    const provider = fakeProvider();
    const r = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider, now: () => now });
    expect(r).toMatchObject({ success: true, outcome: "DEFERRED_FOR_REPLY", deferMs: DEFER_FOR_PENDING_REPLY_MS });
    expect(provider.calls).toHaveLength(0);
    const later = new Date(now.getTime() + 180_000);
    const r2 = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider, now: () => later });
    expect(r2.outcome).toBe("READ");
  });

  it("ولا شي تغيّر ← نجاح بلا نداء ثاني", async () => {
    await setMode("READER_SHADOW");
    const m = await say("CUSTOMER", "بدي ماء الكمأ 0964123348");
    const provider = fakeProvider();
    await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider });
    const again = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider });
    expect(again.outcome).toBe("ALREADY_READ");
    expect(provider.calls).toHaveLength(1);
  });

  it("فشل المزوّد ← نجاح=false (الطابور بيعيد) والقراءة FAILED، وبعد التعافي DONE", async () => {
    await setMode("READER_SHADOW");
    const m = await say("CUSTOMER", "بدي ماء الكمأ 0964123348");
    const provider = fakeProvider(1);
    const r = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider });
    expect(r.success).toBe(false);
    expect(r.outcome).toBe("FAILED");
    const failed = (await readingRow()) as { status: string; attempts: number; lastError: string };
    expect(failed.status).toBe("FAILED");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain("PROVIDER_DOWN");
    const ok = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider });
    expect(ok.outcome).toBe("READ");
    expect(((await readingRow()) as { status: string; lastError: unknown }).status).toBe("DONE");
  });

  it("سيناريو 16 — رد موظف بيسبّب قراءة (مهمة بسبب STAFF بتقيس آخر رد موظف)", async () => {
    await setMode("READER_SHADOW");
    await say("CUSTOMER", "بدي ماء الكمأ");
    const staff = await say("HUMAN", "تمام، رقمك؟ 0964123348");
    const provider = fakeProvider();
    const stale = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: "other", trigger: "STAFF" }, WS, { provider });
    expect(stale.outcome).toBe("STALE_JOB");
    const r = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: staff, trigger: "STAFF" }, WS, { provider });
    expect(r.outcome).toBe("READ");
  });

  it("سيناريو 17 — الموظف ماسك المحادثة (aiState): القارئ بيقرأ بغض النظر", async () => {
    await setMode("READER_SHADOW");
    await db.conversation.update({ where: { id: conversationId }, data: { aiState: "HUMAN_ACTIVE" } } as never);
    const m = await say("CUSTOMER", "بدي ماء الكمأ 0964123348");
    const provider = fakeProvider();
    const r = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider });
    expect(r.outcome).toBe("READ");
  });
});

describe("المعالج — الوضع القديم", () => {
  it("LEGACY_DRAFT: ولا نداء ولا حفظ حتى لو المهمة وصلت", async () => {
    const m = await say("CUSTOMER", "بدي ماء الكمأ 0964123348");
    const provider = fakeProvider();
    const r = await handleReadConversationJob(db as Db, { conversationId, throughMessageId: m }, WS, { provider });
    expect(r).toMatchObject({ success: true, outcome: "LEGACY_DRAFT" });
    expect(provider.calls).toHaveLength(0);
    expect(db._stores.conversationReading).toHaveLength(0);
  });

  it("حمولة ناقصة ← فشل صريح مش صمت", async () => {
    const r = await handleReadConversationJob(db as Db, { conversationId }, WS);
    expect(r.success).toBe(false);
  });
});

describe("تقرير الظل", () => {
  it("بيفرّق: متفق · القارئ لحاله · المسودة سجّلت والقارئ فوّت", async () => {
    const { summarizeShadow } = await import("@/modules/orders/reader/report");
    const s = summarizeShadow(
      [
        { conversationId: "a", stage: "COMPLETE", status: "DONE", flags: ["PHONE_AMBIGUOUS"], missing: [] },
        { conversationId: "b", stage: "COMPLETE", status: "DONE", flags: [], missing: [] },
        { conversationId: "c", stage: "COLLECTING", status: "DONE", flags: [], missing: ["phone"] },
        { conversationId: "d", stage: "NONE", status: "FAILED", flags: [], missing: [] },
      ],
      ["a", "c"]
    );
    expect(s).toMatchObject({ total: 4, failed: 1, wouldCreate: 2, agreed: 1, readerOnly: 1, legacyOnly: 1 });
    expect(s.flags).toEqual([{ flag: "PHONE_AMBIGUOUS", count: 1 }]);
  });
});
