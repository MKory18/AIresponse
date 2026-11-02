/**
 * Telegram outbox — ONE independent message per confirmed order.
 * In-memory DB + fake Telegram fetch (no real network).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { runJobs } from "@/modules/jobs/handlers";
import { formatOrderDate } from "@/modules/orders/notify";
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
  await db.workspace.create({ data: { id: WS, name: "مساحة", slug: "tg", timezone: "Asia/Amman" } } as never);
  const product = await createProduct(db as unknown as Db, AGENT, {
    name: "ماء الكمأة الأصلي",
    sku: "TW-900",
    price: 25,
    currency: "USD",
    offers: [{ title: "قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني", quantity: 3, price: 25 }],
  } as never);
  const productB = await createProduct(db as unknown as Db, AGENT, {
    name: "عسل الكمأة",
    sku: "HON-900",
    price: 50,
    currency: "USD",
  });
  const customer = (await db.customer.create({
    data: { workspaceId: WS, name: "بلال عربش", phone: "0993958355", address: "حلب مدينة الباب", province: "حلب" },
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
  return { product, productB, customer, channel };
}

function notifyJobs() {
  return (db._stores.backgroundJob as any[]).filter((j) => j.type === "notify_order_telegram");
}

async function readyDraft(items: { productName: string; quantity: number; offerTitle?: string }[]) {
  const { customer } = await seed();
  const r = await updateDraftFromExtraction(db as unknown as Db, {
    workspaceId: WS,
    conversationId: db._stores.conversation[0].id,
    customerId: customer.id,
    extraction: { items },
    source: "TEST",
  });
  expect(r.becameReady).toBe(true);
  return r;
}

beforeEach(() => {
  telegramOk();
});

afterEach(() => {
  setTelegramClientFactory(null);
});

describe("Telegram — رسالة مستقلة لكل طلب", () => {
  it("منتجان = طلبان مستقلان = رسالتان منفصلتان", async () => {
    const r = await readyDraft([
      { productName: "ماء الكمأة الأصلي", quantity: 1, offerTitle: "قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني" },
      { productName: "عسل الكمأة", quantity: 1 },
    ]);
    expect(notifyJobs()).toHaveLength(0); // no notification before confirmation

    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.orders).toHaveLength(2);
    expect(notifyJobs()).toHaveLength(2);

    const run = await runJobs(db as never);
    expect(run.failed).toBe(0);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toContain("/bot123456:TEST_TOKEN/sendMessage");
      expect(call.body.chat_id).toBe("-1001234567890");
      expect(call.body.message_thread_id).toBe(42);
      expect(call.body.parse_mode).toBeUndefined();
      const text = String(call.body.text);
      // Exactly one order number + one product per message.
      expect((text.match(/رقم الطلب:/g) ?? []).length).toBe(1);
      expect((text.match(/إسم المنتج:/g) ?? []).length).toBe(1);
      expect(text).toContain("بلال عربش");
      expect(text).toContain("0993958355");
      expect(text).toContain("حلب مدينة الباب");
    }
    const texts = calls.map((c) => String(c.body.text));
    expect(texts.some((t) => t.includes("ماء الكمأة الأصلي") && t.includes("قطعتين + قطعة هدية"))).toBe(true);
    expect(texts.some((t) => t.includes("عسل الكمأة"))).toBe(true);
    // Package: quantity is packages (1), not pieces (3).
    const offerText = texts.find((t) => t.includes("ماء الكمأة الأصلي"))!;
    expect(offerText).toContain("الكمية: 1");
    expect(offerText).toContain("السعر: 25");

    // Retry: no duplicate message.
    await runJobs(db as never);
    expect(calls).toHaveLength(2);
  });

  it("الإعدادات مطفية = الطلب ينحفظ بلا إرسال", async () => {
    await seed({ enabled: false });
    const { customer } = await (async () => {
      // seed() replaced db; re-read customer from the same store.
      return { customer: (db._stores.customer as any[])[0] };
    })();
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة الأصلي", quantity: 1 },
      source: "TEST",
    });
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.orders).toHaveLength(1);
    const run = await runJobs(db as never);
    expect(run.failed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("فشل تيليجرام = فشل مهمة فقط، والطلب يبقى محفوظًا", async () => {
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () =>
            Response.json({ ok: false, error_code: 401, description: "Unauthorized" })) as typeof fetch,
        })
    );
    const r = await readyDraft([{ productName: "ماء الكمأة الأصلي", quantity: 1 }]);
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.created).toBe(true);
    const run = await runJobs(db as never);
    expect(run.failed).toBe(1);

    const order = (db._stores.order as any[]).find((o) => o.id === result.orderId);
    expect(order).toBeTruthy();
    const job = notifyJobs()[0];
    expect(["PENDING", "FAILED"]).toContain(job.status);
  });

  it("حقول الصفحة: بدون عنوان تبقى المسودة جاهزة إذا العنوان غير مطلوب", async () => {
    await seed({ fields: ["product", "quantity", "phone"] });
    const customer = (db._stores.customer as any[])[0];
    const r = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: db._stores.conversation[0].id,
      customerId: customer.id,
      extraction: { productName: "ماء الكمأة الأصلي", quantity: 1 },
      source: "TEST",
    });
    expect(r.missingFields).toEqual([]);
    expect(r.becameReady).toBe(true);
  });
});

describe("نص رسالة تيليجرام", () => {
  it("التنسيق المطلوب حرفيًا وبلا وسوم", () => {
    const text = formatOrderDate(new Date("2026-11-01T13:55:43Z"), "Asia/Amman");
    expect(text).toBe("2026-11-01 16:55:43");
  });
});
