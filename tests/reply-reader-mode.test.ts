/**
 * الحزمة 1.5 — مسار الرد بوضع القارئ (02-ORDER-FLOW §9 · §16: 19).
 *
 * بوضع READER: نداء ذكاء واحد للرد (بلا استخراج ولا handleOrderIntent) · «بطاقة الطلب» و«جدول
 * الأسعار» من القاعدة والهاتف معتّم · «طلبك مؤكد» قبل التثبيت بتنرفض وبعده مسموحة · رد واحد للرشقة.
 * بوضعي LEGACY_DRAFT و READER_SHADOW: المسار القديم بالحرف (الاستخراج لسا شغّال).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { createProduct } from "@/modules/products/service";
import { claimsOrderPlaced } from "@/modules/ai/guardrails";
import { REPLY_BATCH_CAP_MS, REPLY_BATCH_DELAY_MS } from "@/modules/orders/reader/schedule";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws1";
const stubVector = { search: async () => [] } as never;
const originalKey = process.env.OPENROUTER_API_KEY;

let db: FakeDb;
let productId: string;
let structuredCalls: number;
let responses: Array<{ system: string; user: string }>;
let replyQueue: string[];

beforeEach(async () => {
  db = createFakeDb() as FakeDb;
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  structuredCalls = 0;
  responses = [];
  replyQueue = [];
  const mock = new MockAIProvider();
  mock.intentHandler = () => {
    structuredCalls += 1;
    return { intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" };
  };
  mock.responseHandler = (user, system) => {
    responses.push({ system, user });
    return replyQueue.shift() ?? "أهلاً فيك 🌹";
  };
  setMockAIProvider(mock);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          if (new URL(url).pathname.includes("/messages")) return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}-${Math.random()}` });
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
  db._stores.channel.push({ id: "ch1", workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", sendMode: "AUTO_REPLY", externalId: "page-1", market: "SY" });
  db._stores.channelAccount.push({ id: "cacc-1", channelId: "ch1", provider: "FACEBOOK", externalAccountId: "page-1", pageName: "صفحة", encryptedCredentials: encryptSecret("tok") });
  await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
  const p = await createProduct(db as never, { userId: "u1", workspaceId: WS }, { name: "ماء الكمأ", sku: "TW-500", price: 15, currency: "USD" });
  productId = p.id;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
  vi.restoreAllMocks();
});

const setMode = (m: "LEGACY_DRAFT" | "READER_SHADOW" | "READER") =>
  db.workspace.update({ where: { id: WS }, data: { integrationSettings: { orderMode: m } } } as never);

let n = 0;
function inbound(text: string, createdAt?: Date) {
  n += 1;
  return processIncomingMessage(db as never, {
    workspaceId: WS,
    channelType: "FACEBOOK",
    channelId: "ch1",
    externalUserId: "psid-A",
    externalConversationId: "psid-A",
    externalMessageId: `mid-${n}`,
    externalEventId: `evt-${n}`,
    provider: "facebook",
    type: "TEXT",
    text,
    ...(createdAt ? { sentAt: createdAt } : {}),
  });
}
const reply = (r: { conversationId: string; messageId: string }) =>
  processAIMessage(db as never, { workspaceId: WS, conversationId: r.conversationId, messageId: r.messageId }, { vectorStore: stubVector });
/** رسالة سابقة محسومة (وإلا حارس الترتيب بيأجّل الأحدث وراها). */
const markDecided = (messageId: string) => db._stores.aIUsageLog.push({ id: `d-${messageId}`, workspaceId: WS, messageId, purpose: "RESPONSE", status: "SUCCESS", createdAt: new Date() } as never);
const outbound = () => (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND" && !m.isNote);

async function seedReading(conversationId: string, over: Record<string, unknown> = {}) {
  await db.conversationReading.create({
    data: {
      workspaceId: WS,
      conversationId,
      stage: "COLLECTING",
      status: "DONE",
      missing: ["address"],
      data: {
        items: [{ productId, name: "ماء الكمأ", quantity: 2, unitPrice: 15 }],
        recipient: { phone: "0964123348", address: null },
        totals: { currency: "USD" },
      },
      ...over,
    },
  } as never);
}

describe("بوضع READER — نداء واحد للرد", () => {
  it("ولا نداء استخراج، ونداء رد واحد، وبطاقة الطلب + جدول الأسعار + تعليمات البائع بالبرومبت والهاتف معتّم", async () => {
    await setMode("READER");
    const first = await inbound("مرحبا");
    markDecided(first.messageId);
    await seedReading(first.conversationId);
    structuredCalls = 0;
    const r = await inbound("بدي أطلب ماء الكمأ");
    const res = await reply(r);
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    expect(structuredCalls).toBe(0);
    expect(responses).toHaveLength(1);
    const all = responses[0].system + responses[0].user;
    expect(all).toContain("بطاقة الطلب");
    expect(all).toContain("الحالة: قيد التجميع");
    expect(all).toContain("ينقص: العنوان");
    expect(all).toContain("الهاتف: محفوظ ✅");
    expect(all).not.toContain("0964123348");
    expect(all).toContain("جدول الأسعار الرسمي");
    expect(all).toContain("1 = 15 USD");
    expect(all).toContain("2 = 30 USD");
    expect(responses[0].user).toContain("أنت بائع");
    expect(outbound()).toHaveLength(1);
  });

  it("ولا مسودة بتنكتب (handleOrderIntent منشال) حتى لو الرسالة فيها رقم وعنوان", async () => {
    await setMode("READER");
    const r = await inbound("بدي ماء الكمأ 2 حبة 0964123348 درعا شارع (أ)");
    await reply(r);
    expect(db._stores.orderDraft).toHaveLength(0);
    expect(structuredCalls).toBe(0);
  });

  it.each(["LEGACY_DRAFT", "READER_SHADOW"] as const)("%s: المسار القديم بالحرف — الاستخراج شغّال وبلا بطاقة طلب", async (mode) => {
    await setMode(mode);
    const r = await inbound("شو مواصفات المنتج؟");
    await reply(r);
    expect(structuredCalls).toBeGreaterThanOrEqual(1);
    const all = responses[0].system + responses[0].user;
    expect(all).not.toContain("بطاقة الطلب");
    expect(all).not.toContain("أنت بائع");
  });

  it("سعر من جدول الأسعار بيمرّ، وسعر مخترع بيترفض", async () => {
    await setMode("READER");
    const first = await inbound("مرحبا");
    markDecided(first.messageId);
    await seedReading(first.conversationId);
    const r = await inbound("قديش اثنين؟");
    replyQueue = ["الاثنين بـ 30 USD", "الاثنين بـ 99 USD"];
    await reply(r);
    expect(outbound().map((m) => m.text).join(" ")).toContain("30 USD");
  });
});

describe("«طلبك مؤكد» — حسب حالة النظام مش المسودة", () => {
  it("قبل التثبيت ادعاء التثبيت بيتنرفض وبينعاد الرد بالعبارة المطلوبة", async () => {
    await setMode("READER");
    const first = await inbound("مرحبا");
    markDecided(first.messageId);
    await seedReading(first.conversationId);
    const r = await inbound("تمام ثبّتوا");
    replyQueue = ["تم تثبيت طلبك ✅", "سجّلت بياناتك، ورح توصلك رسالة تثبيت برقم الطلب خلال دقائق"];
    await reply(r);
    expect(responses).toHaveLength(2);
    const sent = outbound().map((m) => String(m.text));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("سجّلت بياناتك");
    expect(sent[0]).not.toContain("تم تثبيت");
  });

  it("بعد التثبيت (sealedAt) بطاقة الطلب بتعطي رقم الطلب والادعاء مسموح", async () => {
    await setMode("READER");
    const first = await inbound("مرحبا");
    markDecided(first.messageId);
    await seedReading(first.conversationId, { stage: "COMPLETE", missing: [] });
    const cust = db._stores.customer[0] as any;
    await db.order.create({
      data: {
        workspaceId: WS,
        orderNumber: "ORD-SEALED-1",
        customerId: cust.id,
        conversationId: first.conversationId,
        status: "CONFIRMED",
        confirmationStatus: "CONFIRMED_BY_CUSTOMER",
        recipientPhone: "0964123348",
        deliveryAddress: "شارع (أ)",
        total: 30,
        currency: "USD",
        sealedAt: new Date(),
        idempotencyKey: "reader:test:1",
      },
    } as never);
    const r = await inbound("شو صار بطلبي؟");
    replyQueue = ["تم تثبيت طلبك ✅ رقم الطلب ORD-SEALED-1"];
    await reply(r);
    const all = responses[0].system;
    expect(all).toContain("الحالة: مثبّت · رقم الطلب ORD-SEALED-1");
    expect(all).toContain("طلبات العميل الأخيرة");
    expect(outbound().map((m) => m.text).join(" ")).toContain("تم تثبيت طلبك");
  });

  it("claimsOrderPlaced: الصيغ الجديدة، وما بتمسك «سجّلت بياناتك» ولا السؤال ولا الوعد", () => {
    for (const bad of ["سجّلت الطلب ✅", "أكّدنالك طلبك", "طلبك مؤكد", "الطلب صار مثبّت", "ثبتنا طلبك", "تم تسجيل الطلب", "اعتمدنا الطلب"]) {
      expect(claimsOrderPlaced(bad), bad).toBe(true);
    }
    for (const ok of [
      "سجّلت بياناتك، ورح توصلك رسالة تثبيت برقم الطلب خلال دقائق",
      "هل أثبّت الطلب؟",
      "ابعتلي عنوانك لأثبّت الطلب",
      "بدي اتأكد من الرقم أول",
    ]) {
      expect(claimsOrderPlaced(ok), ok).toBe(false);
    }
  });
});

describe("رد واحد للرشقة (§9.1)", () => {
  it("READER: مهمة الرد بتتأجّل 6 ثواني · القديم فورية", async () => {
    await setMode("READER");
    const r = await inbound("مرحبا");
    const job = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_ai_message" && j.payload.messageId === r.messageId);
    expect(new Date(job.runAfter).getTime() - Date.now()).toBeGreaterThan(REPLY_BATCH_DELAY_MS - 3000);
    await setMode("LEGACY_DRAFT");
    const r2 = await inbound("مرحبا ثانية");
    const job2 = (db._stores.backgroundJob as any[]).find((j) => j.type === "process_ai_message" && j.payload.messageId === r2.messageId);
    expect(job2.runAfter == null || new Date(job2.runAfter).getTime() <= Date.now() + 1000).toBe(true);
  });

  it("3 رسائل متتالية ← رد واحد بيقرا الكل، والأقدم SKIPPED · SUPERSEDED_BY (مغطّاة مش متجاهلة)", async () => {
    await setMode("READER");
    const m1 = await inbound("بدي ماء الكمأ");
    const m2 = await inbound("اثنين");
    const m3 = await inbound("من درعا");
    expect((await reply(m1)).status).toBe("SKIPPED");
    expect((await reply(m2)).status).toBe("SKIPPED");
    const skipped = (db._stores.aIUsageLog as any[]).filter((l) => l.status === "SKIPPED").map((l) => l.error);
    expect(skipped).toContain(`SUPERSEDED_BY:${m3.messageId}`);
    expect(outbound()).toHaveLength(0);
    const last = await reply(m3);
    expect(last.status).toBe("RESPONDED");
    expect(outbound()).toHaveLength(1);
    expect(responses).toHaveLength(1);
    const user = responses[0].user;
    expect(user).toContain("بدي ماء الكمأ");
    expect(user).toContain("اثنين");
    expect(user).toContain("من درعا");
  });

  it("سقف 20 ثانية: أقدم رسالة بلا رد عمرها أكتر من السقف بتنردّ هلأ", async () => {
    await setMode("READER");
    const m1 = await inbound("بدي ماء الكمأ");
    await inbound("وين التوصيل؟");
    const row = (db._stores.message as any[]).find((m) => m.id === m1.messageId);
    row.createdAt = new Date(Date.now() - REPLY_BATCH_CAP_MS - 5000);
    const res = await reply(m1);
    expect(res.status).toBe("RESPONDED");
  });

  it("بالوضع القديم ما في تجميع: كل رسالة بتنردّ لحالها", async () => {
    await setMode("LEGACY_DRAFT");
    const m1 = await inbound("مرحبا");
    await inbound("كيفك");
    expect((await reply(m1)).status).not.toBe("SKIPPED");
  });
});
