/**
 * P22 — طلب بعدة منتجات (سلة) وتخزينه.
 *
 * يثبت: منتجان في رسالة/رسائل، دمج نفس المنتج بلا تكرار، كمية بلا اسم
 * تُحدّث آخر عنصر، إنشاء طلب ببندين وتسعير مجموع + توصيل مرة واحدة، رفض
 * منتج غير متوفر، وتوافق المسودات القديمة المفردة.
 *
 * ⚠️ قاعدة بالذاكرة — سلوك لا PostgreSQL حقيقي.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { parseDraftItems, updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { handleOrderIntent } from "@/modules/orders/intelligence";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-multi-item";
const AGENT = { userId: "agent-multi", workspaceId: WS };

let db: FakeDb;
let productA: { id: string; name: string };
let productB: { id: string; name: string };
let customerId: string;
let conversationId: string;

async function seed() {
  db = createFakeDb() as FakeDb;
  productA = await createProduct(db as unknown as Db, AGENT, {
    name: "ماء الكمأة",
    sku: "MULTI-A",
    price: 100,
    currency: "USD",
  });
  productB = await createProduct(db as unknown as Db, AGENT, {
    name: "عسل الكمأة",
    sku: "MULTI-B",
    price: 50,
    currency: "USD",
  });
  const customer = (await db.customer.create({
    data: {
      workspaceId: WS,
      name: "سامر",
      phone: "0791234567",
      address: "عمان - الدوار السابع",
      province: "عمان",
    },
  } as never)) as { id: string };
  customerId = customer.id;
  const channel = (await db.channel.create({
    data: {
      workspaceId: WS,
      type: "FACEBOOK",
      status: "CONNECTED",
      displayName: "صفحة",
      externalId: "page-multi",
      sendMode: "AUTO_REPLY",
      orderRequiredFields: ["product", "quantity", "phone", "address"],
    },
  } as never)) as { id: string };
  const conversation = (await db.conversation.create({
    data: { workspaceId: WS, customerId, channelId: channel.id, channelConversationId: "conv-multi" },
  } as never)) as { id: string };
  conversationId = conversation.id;
}

async function draftRow() {
  return (await db.orderDraft.findUniqueOrThrow({ where: { conversationId } })) as any;
}

async function merge(extraction: Parameters<typeof updateDraftFromExtraction>[1]["extraction"]) {
  return updateDraftFromExtraction(db as unknown as Db, {
    workspaceId: WS,
    conversationId,
    customerId,
    extraction,
    source: "TEST",
  });
}

beforeEach(seed);

describe("P22 — مسودة طلب متعددة المنتجات", () => {
  it("منتجان في رسالة واحدة: كلاهما يُحفظ، والمسودة تصير جاهزة", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    expect(r.becameReady).toBe(true);
    const items = parseDraftItems(await draftRow());
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ productId: productA.id, quantity: 2 });
    expect(items[1]).toMatchObject({ productId: productB.id, quantity: 1 });
    // مرآة العنصر الأول للحقول المفردة (توافق خلفي).
    expect((await draftRow()).productName).toBe("ماء الكمأة");
  });

  it("منتجان برسالتين + كمية بلا اسم تُحدّث آخر عنصر فقط", async () => {
    await merge({ productName: "ماء الكمأة", quantity: 2 });
    await merge({ productName: "عسل الكمأة", quantity: 1 });
    expect(parseDraftItems(await draftRow())).toHaveLength(2);

    await merge({ quantity: 5 });
    const items = parseDraftItems(await draftRow());
    expect(items.find((i) => i.productId === productA.id)?.quantity).toBe(2);
    expect(items.find((i) => i.productId === productB.id)?.quantity).toBe(5);
  });

  it("نفس المنتج مرة ثانية: سطر واحد (آخر كمية تفوز) بلا تكرار", async () => {
    await merge({ productName: "ماء الكمأة", quantity: 2 });
    await merge({ productName: "ماء الكمأة", quantity: 4 });
    const items = parseDraftItems(await draftRow());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ productId: productA.id, quantity: 4 });
  });

  it("إنشاء الطلب: بندان صحيحان، مجموع 250 + توصيل مرة واحدة", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    expect(r.becameReady).toBe(true);

    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.created).toBe(true);
    expect(result.total).toBe(250);
    expect(result.currency).toBe("USD");

    const orderItems = (db._stores.orderItem as any[]).filter((i) => i.orderId === result.orderId);
    expect(orderItems).toHaveLength(2);
    expect(orderItems.map((i) => i.productNameSnapshot).sort()).toEqual(["عسل الكمأة", "ماء الكمأة"].sort());
    expect(orderItems.reduce((s, i) => s + Number(i.subtotal), 0)).toBe(250);

    const draft = await draftRow();
    expect(draft.state).toBe("CONVERTED");
    expect(draft.orderId).toBe(result.orderId);
  });

  it("منتج ثانٍ غير متوفر: الطلب يُرفض وما بينشأ", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    await db.product.update({ where: { id: productB.id }, data: { stockStatus: "OUT_OF_STOCK" } } as never);

    await expect(
      createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id })
    ).rejects.toMatchObject({ code: "ORDER_RULES_DENIED" });
    expect((db._stores.order as any[]).filter((o) => o.customerId === customerId)).toHaveLength(0);
  });

  it("تأكيد «نعم» بعد سلة منتجين ينشئ الطلب من المحادثة", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    expect(r.becameReady).toBe(true);

    const out = await handleOrderIntent(db as unknown as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      customerText: "نعم",
      extraction: {
        intent: "ORDER_CREATE",
        confidence: 0.95,
        language: "ar",
        entities: {},
        missingFields: [],
        memories: [],
        requestedAction: "CREATE_ORDER",
      } as never,
    });
    expect(out.action).toBe("ORDER_CONFIRMED");
    const orderItems = (db._stores.orderItem as any[]).filter((i) => i.orderId === out.orderId);
    expect(orderItems).toHaveLength(2);
  });

  it("مسودة قديمة مفردة (items فارغة) لسا تنشئ طلبًا صحيحًا", async () => {
    const draft = (await db.orderDraft.create({
      data: {
        workspaceId: WS,
        conversationId,
        customerId,
        state: "READY",
        productId: productA.id,
        productName: "ماء الكمأة",
        quantity: 2,
        phone: "0791234567",
        rawAddress: "عمان - الدوار السابع",
        province: "عمان",
        missingFields: [],
        items: [],
      },
    } as never)) as { id: string };

    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: draft.id });
    expect(result.created).toBe(true);
    expect(result.total).toBe(200);
    expect((db._stores.orderItem as any[]).filter((i) => i.orderId === result.orderId)).toHaveLength(1);
  });

  it("كتالوج الصفحة: منتج خارج الكتالوج ما بينضاف للسلّة", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    // أعد المحاولة بحدود الكتالوج (A فقط) على مسودة جديدة.
    await db.orderDraft.update({
      where: { id: r.draft.id },
      data: { items: [], productId: null, productName: null, quantity: null, state: "COLLECTING", missingFields: [] },
    } as never);
    const limited = await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: {
        items: [
          { productName: "ماء الكمأة", quantity: 2 },
          { productName: "عسل الكمأة", quantity: 1 },
        ],
      },
      allowedProductIds: [productA.id],
      source: "TEST",
    });
    expect(parseDraftItems(limited.draft)).toHaveLength(1);
    expect(parseDraftItems(limited.draft)[0].productId).toBe(productA.id);
  });

  it("منتج بلا كمية: quantity ناقصة لحد ما تنذكر", async () => {
    const r = await merge({ items: [{ productName: "ماء الكمأة" }] });
    expect(r.missingFields).toContain("quantity");
    expect(r.becameReady).toBeFalsy();

    const done = await merge({ quantity: 2 });
    expect(done.missingFields).not.toContain("quantity");
    expect(done.becameReady).toBe(true);
  });
});
