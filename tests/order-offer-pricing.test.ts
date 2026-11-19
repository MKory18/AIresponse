/**
 * عروض الكمية («٣ بـ ٢٥») لازم تظهر بمجموع الطلب.
 *
 * ⚠️ الوكيل كان يقول للزبون «٣ عبوات بـ ٢٥» (جدول الأسعار الرسمي بـ`reader/reply-context.ts`) والطلب كان
 * يتسجّل ٤٥ (`سعر × كمية`). طلب التجربة ORD-MWMC6AHH-0450EA طلع ٤٥ عندنا و٢٥ بالـOMS (اللي بيعيد الحساب
 * من كتالوجه ويرجّع `price_adjusted`، أو `409 PRICE_MISMATCH` حسب سياسة المالك).
 * 🔧 العرض بيتطبّق كخصم بمحرّك المبالغ الوحيد، بشرط **تطابق الكمية حرفيًا**.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { bestOfferFor, calculateCartPricing } from "@/modules/orders/pricing";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft, updateOrderFromChat } from "@/modules/orders/order-service";
import { createProduct } from "@/modules/products/service";

type Db = Prisma.TransactionClient;
const WS = "ws-a";
const AGENT = { userId: "agent-1", workspaceId: WS };
const NOW = new Date("2026-11-18T12:00:00Z");

/** عرض OMS الحقيقي لماء الكمأ: ٣ عبوات (قطعتين + هدية) بـ ٢٥. */
const OFFERS = [{ title: "قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني", quantity: 3, price: 25 }];

describe("bestOfferFor — اختيار العرض", () => {
  it("كمية مطابقة = العرض، والتوفير = سعر الوحدة × الكمية − سعر العرض", () => {
    const o = bestOfferFor(15, 3, OFFERS, NOW);
    expect(o).toMatchObject({ quantity: 3, price: 25, saving: 20 });
  });

  it("كمية مختلفة (١ أو ٤ أو ٦) = بلا عرض — مش بنطبّق عرض على كمية ما انعرضت", () => {
    for (const q of [1, 2, 4, 6]) expect(bestOfferFor(15, q, OFFERS, NOW)).toBeNull();
  });

  it("عرض بلا توفير حقيقي (أغلى من السعر العادي) ما بيتطبّق", () => {
    expect(bestOfferFor(5, 3, [{ title: "x", quantity: 3, price: 25 }], NOW)).toBeNull();
  });

  it("عرض منتهي ما بيتطبّق", () => {
    const expired = [{ ...OFFERS[0], expiresAt: "2026-11-01T00:00:00Z" }];
    expect(bestOfferFor(15, 3, expired, NOW)).toBeNull();
  });

  it("أكتر من عرض بنفس الكمية: الأكبر توفيرًا", () => {
    const two = [
      { title: "a", quantity: 3, price: 30 },
      { title: "b", quantity: 3, price: 25 },
    ];
    expect(bestOfferFor(15, 3, two, NOW)?.title).toBe("b");
  });

  it("بيانات عروض تالفة أو فاضية = بلا عرض (ما بتكسر الحساب)", () => {
    for (const raw of [undefined, null, [], "x", [{ foo: 1 }], [{ title: "t", quantity: 0, price: 5 }]]) {
      expect(bestOfferFor(15, 3, raw, NOW)).toBeNull();
    }
  });
});

describe("calculateCartPricing — العرض بالمجموع", () => {
  const db = createFakeDb() as unknown as Db;
  const price = (quantity: number, extra: Record<string, unknown> = {}) =>
    calculateCartPricing(db, {
      workspaceId: WS,
      items: [{ price: 15, quantity, currency: "USD", offers: OFFERS }],
      now: NOW,
      ...extra,
    });

  it("طلب الحادثة: ٣ × ١٥ = ٤٥ ناقص توفير ٢٠ = ٢٥", async () => {
    const b = await price(3);
    expect(b.subtotal).toBe(45);
    expect(b.discount).toBe(20);
    expect(b.total).toBe(25);
    expect(b.appliedOffers).toHaveLength(1);
  });

  it("عبوة وحدة: ١٥ بلا عرض ولا appliedOffers", async () => {
    const b = await price(1);
    expect(b.total).toBe(15);
    expect(b.discount).toBe(0);
    expect(b.appliedOffers).toBeUndefined();
  });

  it("٤ عبوات: ٦٠ بلا عرض", async () => {
    expect((await price(4)).total).toBe(60);
  });

  it("خصم صريح + عرض بيتجمعوا، والسقف = المجموع (ما بيصير سالب)", async () => {
    const b = await price(3, { discount: 5 });
    expect(b.discount).toBe(25);
    expect(b.total).toBe(20);
    const capped = await price(3, { discount: 100 });
    expect(capped.discount).toBe(45);
    expect(capped.total).toBe(0);
  });

  it("بلا حقل offers: السلوك القديم بالحرف (بلا تغيير)", async () => {
    const b = await calculateCartPricing(db, {
      workspaceId: WS,
      items: [{ price: 15, quantity: 3, currency: "USD" }],
    });
    expect(b).toMatchObject({ subtotal: 45, discount: 0, total: 45 });
    expect(b.appliedOffers).toBeUndefined();
  });
});

describe("الطلب من المسودة", () => {
  let db: ReturnType<typeof createFakeDb>;
  let productId: string;
  let conversationId: string;
  let customerId: string;

  beforeEach(async () => {
    db = createFakeDb();
    const product = await createProduct(db as Db, AGENT, { name: "ماء الكمأ", sku: "TW-1", price: 15, currency: "USD" });
    productId = product.id;
    await db.product.update({ where: { id: productId }, data: { offers: OFFERS } });
    const customer = await db.customer.create({ data: { workspaceId: WS, name: "محمد", phone: "0930000000", status: "INTERESTED" } } as never);
    customerId = customer.id;
    const ch = (await db.channel.create({
      data: { id: "ch-1", workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-1" },
    } as never)) as { id: string };
    const conv = await db.conversation.create({
      data: { workspaceId: WS, customerId, channelId: ch.id, channelConversationId: "c-1" },
    } as never);
    conversationId = conv.id;
  });

  async function draftOf(quantity: number) {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS,
      conversationId,
      customerId,
      extraction: { productId, quantity, phone: "0930000000", rawAddress: "درعا", province: "درعا" },
      source: "TEST",
    });
    return (await db.orderDraft.findFirst({ where: { conversationId } })) as { id: string };
  }

  it("٣ عبوات = ٢٥ (مش ٤٥) — الرقم اللي الوكيل وعد فيه", async () => {
    const draft = await draftOf(3);
    const res = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    expect(res.total).toBe(25);
    const order = (db._stores.order as Array<Record<string, unknown>>)[0];
    expect(Number(order.subtotal)).toBe(45);
    expect(Number(order.discount)).toBe(20);
    expect(Number(order.total)).toBe(25);
  });

  it("عبوة وحدة = ١٥", async () => {
    const draft = await draftOf(1);
    expect((await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id })).total).toBe(15);
  });

  it("تعديل الكمية ٣←١ بيشيل خصم العرض (ما بيصير ٠)", async () => {
    const draft = await draftOf(3);
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    await db.order.update({ where: { id: created.orderId }, data: { status: "NEW" } });
    const res = await updateOrderFromChat(db as Db, AGENT, { conversationId, quantity: 1 });
    expect(res.ok).toBe(true);
    const order = (db._stores.order as Array<Record<string, unknown>>)[0];
    expect(Number(order.subtotal)).toBe(15);
    expect(Number(order.discount)).toBe(0);
    expect(Number(order.total)).toBe(15);
  });

  it("تعديل الكمية ١←٣ بيضيف خصم العرض", async () => {
    const draft = await draftOf(1);
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    await db.order.update({ where: { id: created.orderId }, data: { status: "NEW" } });
    const res = await updateOrderFromChat(db as Db, AGENT, { conversationId, quantity: 3 });
    expect(res.ok).toBe(true);
    const order = (db._stores.order as Array<Record<string, unknown>>)[0];
    expect(Number(order.discount)).toBe(20);
    expect(Number(order.total)).toBe(25);
  });
});
