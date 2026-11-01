/**
 * P19 — الحقول المطلوبة لكل صفحة + إرسال الطلب الجاهز إلى تيليجرام.
 *
 * يثبت:
 *  - حقول إكمال الطلب تتبع الصفحة (بدون عنوان/مع الاسم...).
 *  - المسودة READY تُصفّي مهمة `notify_order_ready` مرة واحدة.
 *  - المهمة ترسل chat_id + topic_id (message_thread_id) + نص فيه بيانات الطلب.
 *  - الإعدادات المطفية أو المسودة الملغاة = لا إرسال.
 *  - فشل تيليجرام لا يكسر المسودة/الطلب (فشل مهمة فقط).
 *
 * ⚠️ قاعدة بالذاكرة وTelegrام وهمي (fetch مزوّر) — سلوك لا اتصال حقيقي.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { runJobs } from "@/modules/jobs/handlers";
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

beforeEach(() => {
  telegramOk();
});

afterEach(() => {
  setTelegramClientFactory(null);
});

describe("P19 — إرسال الطلب الجاهز إلى تيليجرام", () => {
  it("مسودة READY تُصفّي إشعارًا واحدًا، ويوصل للمجموعة والتوبيك", async () => {
    const { customer } = await seed();
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 2 },
      source: "TEST",
    });
    expect(r.becameReady).toBe(true);
    expect(notifyJobs()).toHaveLength(1);

    const run = await runJobs(db as never);
    expect(run.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/bot123456:TEST_TOKEN/sendMessage");
    expect(calls[0].body.chat_id).toBe("-1001234567890");
    expect(calls[0].body.message_thread_id).toBe(42);
    expect(calls[0].body.parse_mode).toBe("HTML");
    const text = String(calls[0].body.text);
    expect(text).toContain("ماء الكمأة");
    expect(text).toContain("0791234567");
    expect(text).toContain("عمان");

    // دورة تانية: لا إرسال مكرر.
    await runJobs(db as never);
    expect(calls).toHaveLength(1);
    const audit = (db._stores.auditLog as any[]).filter((a) => a.action === "order.ready_notified_telegram");
    expect(audit).toHaveLength(1);
  });

  it("الإعدادات مطفية = لا مهمة ولا إرسال", async () => {
    const { customer } = await seed({ enabled: false });
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });
    expect(r.becameReady).toBe(true);
    expect(notifyJobs()).toHaveLength(0);
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
    // العميل ملفه فيه عنوان، لكن حتى لو انمسح: العنوان مش مطلوب لهذه الصفحة.
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

  it("مسودة انلغت بعد الجاهزية: المهمة ما بترسل شي", async () => {
    const { customer } = await seed();
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });
    expect(r.becameReady).toBe(true);
    await db.orderDraft.update({ where: { id: r.draft.id }, data: { state: "CANCELLED" } } as never);

    const run = await runJobs(db as never);
    expect(run.failed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("فشل تيليجرام = فشل مهمة فقط (المسودة والطلب ما بينكسروا)", async () => {
    const { customer } = await seed();
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () =>
            Response.json({ ok: false, error_code: 401, description: "Unauthorized" })) as typeof fetch,
        })
    );
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });
    expect(r.becameReady).toBe(true);

    const run = await runJobs(db as never);
    expect(run.failed).toBe(1);
    const draft = (db._stores.orderDraft as any[]).find((d) => d.id === r.draft.id);
    expect(draft.state).toBe("READY");
    // فشل دائم: المهمة ترجع PENDING (maxAttempts 4) لا تُحذف.
    const job = notifyJobs()[0];
    expect(["PENDING", "FAILED"]).toContain(job.status);
  });
  it("تغيير حقول الصفحة بعد الجاهزية: الإنشاء يعيد التحقق ويرفض الناقص", async () => {
    const { customer } = await seed({ fields: ["product", "quantity", "phone", "address"] });
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
    });
    expect(r.becameReady).toBe(true);

    // الصفحة صارت تطلب الاسم، والاسم مش موجود بالمسودة/الملف.
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

describe("P19 — نص رسالة تيليجرام", () => {
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
