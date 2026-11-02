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
import { transitionOrder } from "@/modules/orders/order-service";
import { assignPageCatalog } from "./helpers/catalog";
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
  await assignPageCatalog(db as unknown as Db, WS, channel.id, [productA.id, productB.id]);
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

  it("منتجان برسالتين + كمية بلا اسم: يسأل أي منتج (لا تخمين)", async () => {
    await merge({ productName: "ماء الكمأة", quantity: 2 });
    await merge({ productName: "عسل الكمأة", quantity: 1 });
    expect(parseDraftItems(await draftRow())).toHaveLength(2);

    const out = await merge({ quantity: 5 });
    expect(out).toHaveProperty("ambiguousCandidates");
    const items = parseDraftItems(await draftRow());
    expect(items.find((i) => i.productId === productA.id)?.quantity).toBe(2);
    expect(items.find((i) => i.productId === productB.id)?.quantity).toBe(1);
  });

  it("نفس المنتج مرة ثانية: سطر واحد (آخر كمية تفوز) بلا تكرار", async () => {
    await merge({ productName: "ماء الكمأة", quantity: 2 });
    await merge({ productName: "ماء الكمأة", quantity: 4 });
    const items = parseDraftItems(await draftRow());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ productId: productA.id, quantity: 4 });
  });

  it("إنشاء الطلب: طلب مستقل لكل منتج (رقم/سجل/سعر مستقل)", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    expect(r.becameReady).toBe(true);

    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.created).toBe(true);
    expect(result.orders).toHaveLength(2);
    expect(result.orders.map((o) => o.total).sort((a, b) => a - b)).toEqual([50, 200]);
    expect(new Set(result.orders.map((o) => o.orderNumber)).size).toBe(2);
    expect(new Set(result.orders.map((o) => o.orderBatchId)).size).toBe(1);

    const orderItems = db._stores.orderItem as any[];
    expect(orderItems).toHaveLength(2);
    // Each order has exactly ONE item.
    const counts = new Map<string, number>();
    for (const item of orderItems) counts.set(item.orderId, (counts.get(item.orderId) ?? 0) + 1);
    expect([...counts.values()]).toEqual([1, 1]);

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
    const createdOrders = (db._stores.order as any[]).filter((o) => o.conversationId === conversationId);
    expect(createdOrders).toHaveLength(2);
    const orderItems = (db._stores.orderItem as any[]).filter((i) =>
      createdOrders.some((o) => o.id === i.orderId)
    );
    expect(orderItems).toHaveLength(2);
    // One item per independent order.
    expect(new Set(orderItems.map((i) => i.orderId)).size).toBe(2);
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

  it("عرض/باقة: الكمية = عدد الباقات، والسعر من العرض لا من القطع", async () => {
    await db.product.update({
      where: { id: productA.id },
      data: { offers: [{ title: "قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني", quantity: 3, price: 25 }] },
    } as never);

    const r = await merge({
      items: [
        {
          productName: "ماء الكمأة",
          offerTitle: "قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني",
          quantity: 1,
        },
      ],
    });
    const items = parseDraftItems(await draftRow());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productId: productA.id,
      offerTitle: "قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني",
      quantity: 1,
    });
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.total).toBe(25);
    const orderItem = (db._stores.orderItem as any[]).find((i) => i.orderId === result.orderId);
    expect(orderItem.quantity).toBe(1); // packages, not 3 pieces
    expect(Number(orderItem.unitPrice)).toBe(25);
    expect(orderItem.offerNameSnapshot).toContain("قطعة هدية");
    expect(orderItem.offerQuantity).toBe(3);
  });

  it("نفس المنتج بعرضين مختلفين = بندان وطلبان مستقلان", async () => {
    await db.product.update({
      where: { id: productA.id },
      data: {
        offers: [
          { title: "باقة قطعتين", quantity: 2, price: 80 },
          { title: "باقة 3 قطع", quantity: 3, price: 110 },
        ],
      },
    } as never);
    await merge({ productName: "ماء الكمأة", offerTitle: "باقة قطعتين", quantity: 1 });
    await merge({ productName: "ماء الكمأة", offerTitle: "باقة 3 قطع", quantity: 1 });
    expect(parseDraftItems(await draftRow())).toHaveLength(2);
  });

  it("عرض غير موجود: يسأل ولا يخمّن سعرًا", async () => {
    await db.product.update({
      where: { id: productA.id },
      data: { offers: [{ title: "باقة قطعتين", quantity: 2, price: 80 }] },
    } as never);
    const out = await merge({ productName: "ماء الكمأة", offerTitle: "باقة مفقودة", quantity: 1 });
    expect(out).toHaveProperty("clarification");
    expect(parseDraftItems(await draftRow())).toHaveLength(0);
  });

  it("التحقق النهائي: منتج خارج كتالوج الصفحة ما بينشئ طلب", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 1 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    // The page catalog is assigned in seed(); remove the second product from it.
    const link = (await db.catalogPageAssignment.findUnique({
      where: { channelId: db._stores.channel[0].id },
    })) as { catalogId: string };
    await db.catalogProduct.deleteMany({
      where: { catalogId: link.catalogId, productId: productB.id },
    } as never);

    await expect(
      createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id })
    ).rejects.toMatchObject({ code: "ORDER_PRODUCT_OUTSIDE_CATALOG" });
    expect((db._stores.order as any[]).filter((o) => o.customerId === customerId)).toHaveLength(0);
  });

  it("التوصيل يُوزّع بالكسور الصحيحة على الطلبات ومجموعه = الرسوم", async () => {
    await db.deliveryRule.create({
      data: { workspaceId: WS, province: "عمان", fee: 10, isAvailable: true },
    } as never);
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.orders.map((o) => o.total).sort((a, b) => a - b)).toEqual([52, 208]);
    const fees = (db._stores.order as any[])
      .filter((o) => o.orderBatchId === result.orders[0]!.orderBatchId)
      .map((o) => Number(o.deliveryFee));
    expect(fees.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("صفحة بلا كتالوج: لا يمكن إنشاء أي طلب", async () => {
    const r = await merge({ items: [{ productName: "ماء الكمأة", quantity: 1 }] });
    await db.catalogPageAssignment.deleteMany({
      where: { channelId: db._stores.channel[0].id },
    } as never);
    await expect(
      createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id })
    ).rejects.toMatchObject({ code: "ORDER_PRODUCT_OUTSIDE_CATALOG" });
  });

  it("إلغاء أحد الطلبين لا يلغي الآخر", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 1 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    const result = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: r.draft.id });
    expect(result.orders).toHaveLength(2);
    await transitionOrder(db as unknown as Db, AGENT, result.orders[1]!.orderId, "CANCELLED");
    const rows = (db._stores.order as any[]).filter((o) => o.orderBatchId === result.orders[0]!.orderBatchId);
    expect(rows.filter((o) => o.status === "CANCELLED")).toHaveLength(1);
    expect(rows.filter((o) => o.status === "CONFIRMED")).toHaveLength(1);
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
