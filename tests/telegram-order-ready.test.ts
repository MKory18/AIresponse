/**
 * الترحيل لتلجرام — **الطلبات فقط** (قرار المالك: المسودة ما بتترحّل).
 *
 * يثبت:
 *  - المسودة READY ما بتصفّي مهمة ولا بترسل شي.
 *  - إنشاء الطلب الرسمي يرسل رسالة واحدة لإعدادات المساحة (chat + topic).
 *  - سجل `order.telegram_notified` = مصدر شعار «تم ترحيله للتلجرام» بالقائمة.
 *  - الإعدادات المطفية أو فشل تلجرام = الطلب ينشأ عادي، بلا شعار وبلا كسر.
 *  - حقول إكمال الطلب تتبع الصفحة.
 *
 * ⚠️ قاعدة بالذاكرة وتلجرام وهمي (fetch مزوّر) — سلوك لا اتصال حقيقي.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft, listOrders } from "@/modules/orders/order-service";
import { buildOrderReadyMessage, escapeTelegramHtml } from "@/modules/integrations/telegram-orders";
import { TelegramClient, setTelegramClientFactory } from "@/modules/channels/telegram/client";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-telegram-orders";
const AGENT = { userId: "agent-tg", workspaceId: WS };

let db: FakeDb;
let calls: { url: string; body: Record<string, unknown> }[];

function telegramOk() {
  calls = [];
  setTelegramClientFactory(
    () =>
      new TelegramClient({
        fetchImpl: (async (url: string, init: { body?: string }) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
          return Response.json({ ok: true, result: { message_id: 555 } });
        }) as typeof fetch,
      })
  );
}

async function seed(opts?: { enabled?: boolean; fields?: string[] }) {
  db = createFakeDb() as FakeDb;
  const product = await createProduct(db as unknown as Db, AGENT, {
    name: "ماء الكمأة",
    sku: "TW-900",
    price: 150000,
    currency: "SYP",
  });
  await createProduct(db as unknown as Db, AGENT, {
    name: "عسل الكمأة",
    sku: "HON-900",
    price: 50000,
    currency: "SYP",
  });
  const customer = (await db.customer.create({
    data: { workspaceId: WS, name: "سامر", phone: "0791234567", address: "عمان - الدوار السابع", province: "عمان" },
  } as never)) as { id: string };
  const channel = (await db.channel.create({
    data: {
      workspaceId: WS,
      type: "FACEBOOK",
      status: "CONNECTED",
      displayName: "صفحة الطلبات",
      externalId: "page-tg",
      sendMode: "AUTO_REPLY",
      orderRequiredFields: opts?.fields ?? ["product", "quantity", "phone", "address"],
    },
  } as never)) as { id: string };
  await db.conversation.create({
    data: { workspaceId: WS, customerId: customer.id, channelId: channel.id, channelConversationId: "conv-tg" },
  } as never);
  await db.telegramOrderSettings.create({
    data: {
      workspaceId: WS,
      enabled: opts?.enabled ?? true,
      botTokenEnc: encryptSecret("123456:TEST_TOKEN"),
      chatId: "-1001234567890",
      topicId: "42",
    },
  } as never);
  return { product, customer, channel };
}

function notifyJobs() {
  return (db._stores.backgroundJob as any[]).filter((j) => j.type === "notify_order_ready");
}

async function readyDraft(customerId: string) {
  // قرار المالك: منتج واحد لكل مسودة.
  return updateDraftFromExtraction(db as unknown as Db, {
    workspaceId: WS,
    conversationId: db._stores.conversation[0].id,
    customerId,
    extraction: { items: [{ productName: "ماء الكمأة", quantity: 2 }] },
    source: "TEST",
  });
}

beforeEach(() => {
  telegramOk();
});

afterEach(() => {
  setTelegramClientFactory(null);
});

describe("الترحيل لتلجرام — الطلبات فقط", () => {
  it("مسودة READY ما بترحّل: لا مهمة ولا إرسال", async () => {
    const { customer } = await seed();
    const r = await readyDraft(customer.id);
    expect(r.becameReady).toBe(true);
    expect(notifyJobs()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("إنشاء الطلب يرسل مرة واحدة للمجموعة/التوبيك + يسجّل الشعار", async () => {
    const { customer } = await seed();
    const draft = await readyDraft(customer.id);
    expect(draft.becameReady).toBe(true);

    const created = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: draft.draft.id });
    expect(created.orderNumber).toBeTruthy();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/bot123456:TEST_TOKEN/sendMessage");
    expect(calls[0].body.chat_id).toBe("-1001234567890");
    expect(calls[0].body.message_thread_id).toBe(42);
    const text = String(calls[0].body.text);
    expect(text).toContain("ماء الكمأة");
    expect(text).toContain(created.orderNumber);

    const audit = (db._stores.auditLog as any[]).filter((a) => a.action === "order.telegram_notified");
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe(created.orderId);

    // الشعار بالقائمة حقيقة الإرسال.
    const list = await listOrders(db as unknown as Db, { workspaceId: WS });
    const row = list.items.find((o) => o.id === created.orderId) as { telegramNotified?: boolean };
    expect(row?.telegramNotified).toBe(true);
  });

  it("إعدادات مطفية = لا إرسال ولا شعار (الطلب ينشأ)", async () => {
    const { customer } = await seed({ enabled: false });
    const draft = await readyDraft(customer.id);
    const created = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: draft.draft.id });

    expect(created.orderId).toBeTruthy();
    expect(calls).toHaveLength(0);
    const audit = (db._stores.auditLog as any[]).filter((a) => a.action === "order.telegram_notified");
    expect(audit).toHaveLength(0);
    const list = await listOrders(db as unknown as Db, { workspaceId: WS });
    const row = list.items.find((o) => o.id === created.orderId) as { telegramNotified?: boolean };
    expect(row?.telegramNotified).toBe(false);
  });

  it("فشل تلجرام = الطلب ينشأ بلا شعار وبلا كسر", async () => {
    const { customer } = await seed();
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () =>
            Response.json({ ok: false, error_code: 401, description: "Unauthorized" })) as typeof fetch,
        })
    );
    const draft = await readyDraft(customer.id);
    const created = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: draft.draft.id });

    expect(created.orderId).toBeTruthy();
    expect((db._stores.auditLog as any[]).filter((a) => a.action === "order.telegram_notified")).toHaveLength(0);
    const list = await listOrders(db as unknown as Db, { workspaceId: WS });
    const row = list.items.find((o) => o.id === created.orderId) as { telegramNotified?: boolean };
    expect(row?.telegramNotified).toBe(false);
  });

  it("حقول الصفحة: بدون عنوان تبقى المسودة جاهزة إذا العنوان غير مطلوب", async () => {
    const { customer } = await seed({ fields: ["product", "quantity", "phone"] });
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });
    expect(r.missingFields).toEqual([]);
    expect(r.becameReady).toBe(true);
  });

  it("حقل الاسم مطلوب: ما بتصير جاهزة قبل توفّر الاسم", async () => {
    const { customer } = await seed({ fields: ["product", "quantity", "phone", "address", "name"] });
    await db.customer.update({ where: { id: customer.id }, data: { name: null } } as never);
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });
    expect(r.missingFields).toContain("name");
    expect(r.becameReady).toBeFalsy();

    const done = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { customerName: "سامر" },
      source: "TEST",
    });
    expect(done.missingFields).toEqual([]);
    expect(done.becameReady).toBe(true);
  });

  it("تغيير حقول الصفحة بعد الجاهزية: الإنشاء يعيد التحقق ويرفض الناقص", async () => {
    const { customer } = await seed({ fields: ["product", "quantity", "phone", "address"] });
    const r = await readyDraft(customer.id);
    expect(r.becameReady).toBe(true);

    await db.channel.update({
      where: { id: db._stores.channel[0].id },
      data: { orderRequiredFields: ["product", "quantity", "phone", "address", "name"] },
    } as never);
    await db.customer.update({ where: { id: customer.id }, data: { name: null } } as never);
    await db.orderDraft.update({ where: { id: r.draft.id }, data: { customerName: null } } as never);

    await expect(
      createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id })
    ).rejects.toMatchObject({ code: "ORDER_MISSING_FIELDS" });
    const draft = (db._stores.orderDraft as any[]).find((d) => d.id === r.draft.id);
    expect(draft.missingFields).toContain("name");
  });
});

describe("نص رسالة تيليجرام", () => {
  it("يهرّب HTML ويمنع حقن الوسوم", () => {
    const text = buildOrderReadyMessage({
      pageName: "<b>صفحة</b>",
      customerName: "سامر & علي",
      phone: "0791234567",
      province: "عمان",
      address: "شارع <script>",
      productName: "منتج",
      quantity: 2,
      unitPrice: "100",
      currency: "SYP",
      estimatedTotal: "200",
    });
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("&amp;");
    expect(escapeTelegramHtml("<x>")).toBe("&lt;x&gt;");
    expect(text).toContain("100 SYP");
    expect(text).toContain("200 SYP");
  });
});
