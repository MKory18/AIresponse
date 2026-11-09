/**
 * تثبيت إصلاحين:
 *  - تأكيد الطلب ما بيكمل إذا تعدّلت المسودة بنفس اللحظة (طلب بقيم قديمة).
 *  - تأكيد متزامن مرتين = طلب واحد (نفس الطلب يرجع بدل خطأ).
 * ⚠️ قاعدة بالذاكرة — سلوك لا PostgreSQL حقيقي.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { listOpenDrafts, updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft } from "@/modules/orders/order-service";

type Db = Prisma.TransactionClient;
const WS = "ws-confirm-race";
const AGENT = { userId: "agent-race", workspaceId: WS };

let db: any;
let customerId: string;
let conversationId: string;

beforeEach(async () => {
  db = createFakeDb();
  await createProduct(db as Db, AGENT, { name: "ماء الكمأة", sku: "RACE-A", price: 100, currency: "USD" });
  customerId = ((await db.customer.create({
    data: { workspaceId: WS, name: "سامر", phone: "0791234567", address: "عمان - الدوار السابع", province: "عمان" },
  })) as { id: string }).id;
  const channel = (await db.channel.create({
    data: {
      workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "page-race",
      sendMode: "AUTO_REPLY", orderRequiredFields: ["product", "quantity", "phone", "address"],
    },
  })) as { id: string };
  conversationId = ((await db.conversation.create({
    data: { workspaceId: WS, customerId, channelId: channel.id, channelConversationId: "conv-race" },
  })) as { id: string }).id;
  await updateDraftFromExtraction(db as Db, {
    workspaceId: WS, conversationId, customerId, extraction: { productName: "ماء الكمأة", quantity: 2 }, source: "TEST",
  });
});

async function readyDraft() {
  const [d] = (await listOpenDrafts(db as Db, WS, conversationId)) as any[];
  expect(d.state).toBe("READY");
  return d;
}

describe("تأكيد الطلب — تزامن", () => {
  it("تعديل المسودة أثناء التأكيد = رفض 409 وما بينشأ طلب بقيم قديمة", async () => {
    const draft = await readyDraft();
    // نحاكي عميل بيعدّل الكمية بعد ما بدأ التأكيد (أول استعلام منتج).
    let bumped = false;
    for (const name of ["findUnique", "findMany", "findFirst"] as const) {
      const original = db.product[name]?.bind(db.product);
      if (!original) continue;
      db.product[name] = async (...args: unknown[]) => {
        if (!bumped) {
          bumped = true;
          await db.orderDraft.update({ where: { id: draft.id }, data: { notes: "عدّل العميل" } });
        }
        return original(...args);
      };
    }
    await expect(createOrderFromDraft(db as Db, AGENT, { draftId: draft.id })).rejects.toMatchObject({
      code: "DRAFT_CHANGED",
      statusCode: 409,
    });
    expect(await db.order.count({ where: { workspaceId: WS } })).toBe(0);
    const after = await db.orderDraft.findUnique({ where: { id: draft.id } });
    expect(after.state).not.toBe("CONVERTED");
  });

  it("تأكيد عادي بلا تعديل ينجح وينشئ طلباً واحداً", async () => {
    const draft = await readyDraft();
    const r = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    expect(r.created).toBe(true);
    expect(await db.order.count({ where: { workspaceId: WS } })).toBe(1);
  });

  it("تأكيد مكرر = نفس الطلب (created=false) بلا طلب ثانٍ", async () => {
    const draft = await readyDraft();
    const first = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    const second = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    expect(second.orderId).toBe(first.orderId);
    expect(second.created).toBe(false);
    expect(await db.order.count({ where: { workspaceId: WS } })).toBe(1);
  });
});

describe("تعديل مسودة جاهزة = تأكيد جديد", () => {
  const merge = (extraction: Record<string, unknown>) =>
    updateDraftFromExtraction(db as Db, {
      workspaceId: WS, conversationId, customerId, extraction: extraction as never, source: "TEST",
    });

  it("تغيير الكمية على مسودة READY بيطلب تأكيداً جديداً (becameReady)", async () => {
    const before = await readyDraft();
    const r = await merge({ productName: "ماء الكمأة", quantity: 5 });
    expect(r.becameReady).toBe(true);
    const [after] = (await listOpenDrafts(db as Db, WS, conversationId)) as any[];
    expect(after.id).toBe(before.id);
    expect(after.quantity).toBe(5);
    expect(after.state).toBe("READY");
  });

  it("نفس الكمية بلا تغيير ما بيعيد طلب التأكيد", async () => {
    await readyDraft();
    const r = await merge({ productName: "ماء الكمأة", quantity: 2 });
    expect(r.becameReady).toBeFalsy();
  });

  it("تغيير العنوان بيطلب تأكيداً جديداً", async () => {
    await readyDraft();
    const r = await merge({ rawAddress: "إربد - شارع الجامعة" });
    expect(r.becameReady).toBe(true);
  });
});

describe("لقطة المستلم على الطلب", () => {
  it("الطلب بيحفظ هاتف واسم المستلم من المسودة حتى لو اختلف عن ملف العميل", async () => {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS, conversationId, customerId,
      extraction: { phone: "0777654321", customerName: "ليلى (هدية)" } as never, source: "TEST",
    });
    const draft = await readyDraft();
    expect(draft.phone).toContain("777654321");
    const r = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    const order = await db.order.findUnique({ where: { id: r.orderId } });
    expect(order.recipientPhone).toBe(draft.phone);
    expect(order.recipientName).toBe("ليلى (هدية)");
    expect(order.recipientPhone).not.toContain("791234567");
  });
});
