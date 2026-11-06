/**
 * قرار المالك — كل منتج مسودة مستقلة (لا سلة).
 *
 * يثبت:
 *  - منتجان في رسالة/رسائل = **مسودتان منفصلتان**، منتج واحد بكل مسودة.
 *  - نفس المنتج مرة ثانية = نفس المسودة (آخر كمية تفوز).
 *  - كمية بلا اسم = آخر مسودة مفتوحة فقط.
 *  - كل مسودة تُنشئ طلبها المستقل (رقم/مجموع مستقل).
 *  - «نعم» مع مسودتين جاهزتين = سؤال أي واحدة، وبعد التسمية يتأكد المطلوب.
 *
 * ⚠️ قاعدة بالذاكرة — سلوك لا PostgreSQL حقيقي.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { listOpenDrafts, parseDraftItems, updateDraftFromExtraction } from "@/modules/orders/draft-service";
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
    data: { workspaceId: WS, name: "سامر", phone: "0791234567", address: "عمان - الدوار السابع", province: "عمان" },
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

async function openDrafts() {
  return (await listOpenDrafts(db as unknown as Db, WS, conversationId)) as any[];
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

function itemOf(draft: any) {
  const items = parseDraftItems(draft);
  expect(items).toHaveLength(1);
  return items[0];
}

const confirm = (text: string) =>
  handleOrderIntent(db as unknown as Db, {
    workspaceId: WS,
    conversationId,
    customerId,
    customerText: text,
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

beforeEach(seed);

describe("مسودة مستقلة لكل منتج", () => {
  it("منتجان في رسالة واحدة = مسودتان، كل واحدة عنصر واحد وجاهزة", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    expect(r.becameReady).toBe(true);

    const drafts = await openDrafts();
    expect(drafts).toHaveLength(2);
    const byProduct = new Map(drafts.map((d) => [itemOf(d).productId, d]));
    expect(itemOf(byProduct.get(productA.id)!).quantity).toBe(2);
    expect(itemOf(byProduct.get(productB.id)!).quantity).toBe(1);
    for (const d of drafts) expect(d.state).toBe("READY");
  });

  it("منتجان برسالتين + كمية بلا اسم تُحدّث آخر مسودة فقط", async () => {
    await merge({ productName: "ماء الكمأة", quantity: 2 });
    await merge({ productName: "عسل الكمأة", quantity: 1 });
    expect(await openDrafts()).toHaveLength(2);

    await merge({ quantity: 5 });
    const drafts = await openDrafts();
    const byProduct = new Map(drafts.map((d) => [itemOf(d).productId, d]));
    expect(itemOf(byProduct.get(productA.id)!).quantity).toBe(2);
    expect(itemOf(byProduct.get(productB.id)!).quantity).toBe(5);
  });

  it("نفس المنتج مرة ثانية: نفس المسودة (آخر كمية تفوز)", async () => {
    await merge({ productName: "ماء الكمأة", quantity: 2 });
    await merge({ productName: "ماء الكمأة", quantity: 4 });
    const drafts = await openDrafts();
    expect(drafts).toHaveLength(1);
    expect(itemOf(drafts[0])).toMatchObject({ productId: productA.id, quantity: 4 });
  });

  it("كل مسودة تُنشئ طلبها المستقل برقم ومجموع مستقل", async () => {
    const r = await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    const drafts = await openDrafts();
    const water = drafts.find((d) => itemOf(d).productId === productA.id)!;
    const honey = drafts.find((d) => itemOf(d).productId === productB.id)!;
    void r;

    const orderA = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: water.id });
    const orderB = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: honey.id });

    expect(orderA.orderId).not.toBe(orderB.orderId);
    expect(orderA.orderNumber).not.toBe(orderB.orderNumber);
    expect(orderA.total).toBe(200); // 100 × 2
    expect(orderB.total).toBe(50); // 50 × 1

    const itemsA = (db._stores.orderItem as any[]).filter((i) => i.orderId === orderA.orderId);
    const itemsB = (db._stores.orderItem as any[]).filter((i) => i.orderId === orderB.orderId);
    expect(itemsA).toHaveLength(1);
    expect(itemsB).toHaveLength(1);
    expect(itemsA[0].productNameSnapshot).toBe("ماء الكمأة");
    expect(itemsB[0].productNameSnapshot).toBe("عسل الكمأة");
  });

  it("«نعم» مع مسودتين جاهزتين = سؤال، وبعد التسمية يتأكد المطلوب", async () => {
    await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });

    const ambiguous = await confirm("نعم");
    expect(ambiguous.action).toBe("ASK_MISSING_FIELD");
    expect(ambiguous.summaryText).toContain("ماء الكمأة");
    expect(ambiguous.summaryText).toContain("عسل الكمأة");
    expect((db._stores.order as any[]).filter((o) => o.customerId === customerId)).toHaveLength(0);

    const confirmed = await confirm("أكد ماء الكمأة");
    expect(confirmed.action).toBe("ORDER_CONFIRMED");
    const items = (db._stores.orderItem as any[]).filter((i) => i.orderId === confirmed.orderId);
    expect(items).toHaveLength(1);
    expect(items[0].productNameSnapshot).toBe("ماء الكمأة");
  });

  it("منتج غير متوفر: طلبه يُرفض ولا ينشأ، وطلب المنتج التاني يمشي", async () => {
    await merge({
      items: [
        { productName: "ماء الكمأة", quantity: 2 },
        { productName: "عسل الكمأة", quantity: 1 },
      ],
    });
    await db.product.update({ where: { id: productB.id }, data: { stockStatus: "OUT_OF_STOCK" } } as never);

    const drafts = await openDrafts();
    const water = drafts.find((d) => itemOf(d).productId === productA.id)!;
    const honey = drafts.find((d) => itemOf(d).productId === productB.id)!;

    await expect(
      createOrderFromDraft(db as unknown as Db, AGENT, { draftId: honey.id })
    ).rejects.toMatchObject({ code: "ORDER_RULES_DENIED" });
    const ok = await createOrderFromDraft(db as unknown as Db, AGENT, { draftId: water.id });
    expect(ok.created).toBe(true);
    expect((db._stores.order as any[]).filter((o) => o.customerId === customerId)).toHaveLength(1);
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
  });
});
