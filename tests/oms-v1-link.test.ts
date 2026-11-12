import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { encryptSecret } from "@/core/crypto";
import { buildProductContext } from "@/modules/ai/context-builder";
import { OmsClient, mapV1Product, setOmsClientFactory, toV1OrderBody } from "@/modules/oms/client";
import { saveOmsConnection, getOmsConnectionView } from "@/modules/oms/connection";
import { syncProductsFromOms } from "@/modules/oms/sync";
import { handoffOrderToOms, omsIdempotencyKey } from "@/modules/oms/handoff";
import { autoHandoffKey, handleAutoHandoffJob } from "@/modules/oms/auto-handoff";

/**
 * ربط الردود بالـ OMS عبر باب /api/v1 (قرار المالك 2026-11-12):
 * كل طلب مؤكد بينزل بالـ OMS · منتجات الردود = منتجات الـ OMS.
 * الـ OMS هون مزيّف بـ fetch — ولا شبكة.
 */

type Db = Prisma.TransactionClient;
const WS = "ws-a";
const ACTOR = { userId: "owner-1", workspaceId: WS };
const OMS_URL = "https://oms.example.com";

type Call = { method: string; path: string; headers: Record<string, string>; body: any };
let calls: Call[];
let omsProducts: unknown[];
let orderAnswer: (call: Call) => Response;
let db: ReturnType<typeof createFakeDb>;

function fakeOms() {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method: init?.method ?? "GET", path: u.pathname + u.search, headers, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (headers.authorization !== "Bearer zk1_test_token_value") {
      return Response.json({ error: { code: "TOKEN_INVALID", message: "x" } }, { status: 401 });
    }
    if (u.pathname === "/api/v1/products") return Response.json({ items: omsProducts });
    if (u.pathname === "/api/v1/orders" && call.method === "POST") return orderAnswer(call);
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }) as typeof fetch;
  setOmsClientFactory((deps) => new OmsClient({ ...deps, fetchImpl, maxGetAttempts: 1, timeoutMs: 2000 }));
}

async function connect(autoHandoff = true) {
  await saveOmsConnection(db as unknown as Db, ACTOR, { baseUrl: OMS_URL, token: "zk1_test_token_value", autoHandoff });
}

beforeEach(() => {
  db = createFakeDb();
  calls = [];
  omsProducts = [];
  orderAnswer = (call) =>
    Response.json(
      {
        order_id: "oms-ord-1",
        order_number: "SY-2026-0148",
        status: "NEW",
        price_adjusted: false,
        totals: { subtotal: "30.00", discount: "0.00", delivery_fee: "0.00", total: String(call.body?.totals?.total ?? "0.00"), currency: "USD" },
      },
      { status: 201 }
    );
  fakeOms();
});

afterEach(() => setOmsClientFactory(null));

describe("عميل باب v1", () => {
  it("بيقرأ منتج الـ OMS (مبالغ نص عشري) وبيكتب جسم الطلب حسب v1OrderSchema", () => {
    const p = mapV1Product({
      code: "TIN01",
      name: "منتج الطنين",
      price: "15.00",
      currency: "USD",
      stock_status: "LOW_STOCK",
      offers: [{ title: "حبتين بـ 25", quantity: 2, price: "25.00", saving: "5.00", remaining_qty: null, expires_at: null }],
      complements: [],
    });
    expect(p).toMatchObject({ code: "TIN01", price: 15, currency: "USD", stockStatus: "LOW_STOCK" });
    expect(p.offers[0]).toEqual({ title: "حبتين بـ 25", quantity: 2, price: 25, saving: 5, remainingQty: null, expiresAt: null });

    const body = toV1OrderBody({
      idempotencyKey: "k",
      orderNumber: "ORD-1",
      channel: "messenger",
      customer: { name: "أبو أحمد", phone: "0936654998", city: "حلب", address: "الفرقان" },
      items: [{ code: "TIN01", name: "منتج الطنين", quantity: 2, unitPrice: 15, lineTotal: 30 }],
      totals: { subtotal: 30, discount: 0, deliveryFee: 3, total: 33, currency: "USD" },
      notes: null,
      attribution: null,
    });
    expect(body).toMatchObject({
      external_ref: "ORD-1",
      source: "replies",
      items: [{ product_code: "TIN01", quantity: 2, unit_price: "15.00", line_total: "30.00" }],
      totals: { subtotal: "30.00", delivery_fee: "3.00", total: "33.00", currency: "USD" },
      attribution: { method: "NONE" },
    });
  });
});

describe("الاتصال", () => {
  it("التوكن بينحفظ مشفّر وما بيرجع للواجهة · الإرسال التلقائي مفعّل من أول حفظ", async () => {
    await connect();
    const row = (await (db as any).omsConnection.findUnique({ where: { workspaceId: WS } })) as Record<string, unknown>;
    expect(String(row.tokenEncrypted)).not.toContain("zk1_test_token_value");
    expect(row.apiVersion).toBe("v1");
    const view = await getOmsConnectionView(db as unknown as Db, WS);
    expect(view).toMatchObject({ configured: true, hasToken: true, autoHandoff: true, baseUrl: OMS_URL });
    expect(JSON.stringify(view)).not.toContain("zk1_");
  });

  it("رابط http عام أو داخلي بينرفض قبل ما يطلع التوكن", async () => {
    await expect(
      saveOmsConnection(db as unknown as Db, ACTOR, { baseUrl: "http://oms.example.com", token: "zk1_test_token_value" })
    ).rejects.toMatchObject({ code: "INVALID_SYSTEM_URL" });
    expect(calls).toHaveLength(0);
  });
});

describe("منتجات الردود = منتجات الـ OMS", () => {
  async function seed() {
    const sameCode = await createProduct(db as unknown as Db, ACTOR, { name: "اسم قديم", sku: "TIN01", price: 10, currency: "USD" });
    const sameName = await createProduct(db as unknown as Db, ACTOR, { name: "كريم  الكمأة", sku: "OLD-CREAM", price: 7, currency: "USD" });
    const localOnly = await createProduct(db as unknown as Db, ACTOR, { name: "منتج محلي بس", sku: "LOCAL-1", price: 5, currency: "USD" });
    const catalog = (await (db as any).catalog.create({ data: { workspaceId: WS, name: "كتالوج الصفحة" } })) as { id: string };
    await (db as any).catalogProduct.create({ data: { catalogId: catalog.id, productId: sameName.id, sortOrder: 0 } });
    return { sameCode, sameName, localOnly, catalog };
  }

  it("نفس الرمز بيتحدّث · نفس الاسم بياخد رمز الـ OMS ويضل بكتالوجه · الجديد لكل الصفحات · المحلي بيتوقف (مش بينحذف)", async () => {
    const s = await seed();
    await connect();
    omsProducts = [
      { code: "TIN01", name: "منتج الطنين", price: "15.00", currency: "USD", stock_status: "IN_STOCK", offers: [], complements: [] },
      { code: "CRM02", name: "كريم الكمأة", price: "22.50", currency: "USD", stock_status: "OUT_OF_STOCK", offers: [], complements: [] },
      { code: "NEW03", name: "منتج جديد", price: "9.00", currency: "USD", stock_status: "LOW_STOCK", offers: [{ title: "حبتين بـ 16", quantity: 2, price: "16.00", saving: "2.00" }], complements: [] },
    ];

    const r = await syncProductsFromOms(db as unknown as Db, ACTOR);
    expect(r).toMatchObject({ received: 3, updated: 2, created: 1, deactivated: 1, failed: 0, deactivationSkipped: null });

    const byId = async (id: string) => (await db.product.findUnique({ where: { id } })) as any;
    expect(await byId(s.sameCode.id)).toMatchObject({ name: "منتج الطنين", sku: "TIN01", isActive: true, syncedFromOms: true });
    expect(Number((await byId(s.sameCode.id)).price)).toBe(15);
    expect(await byId(s.sameName.id)).toMatchObject({ sku: "CRM02", stockStatus: "OUT_OF_STOCK", isActive: true });
    expect(Number((await byId(s.sameName.id)).price)).toBe(22.5);
    // ما انحذف — توقف بس.
    expect(await byId(s.localOnly.id)).toMatchObject({ isActive: false });

    const created = (await db.product.findFirst({ where: { workspaceId: WS, sku: "NEW03" } })) as any;
    expect(created).toMatchObject({ isActive: true, syncedFromOms: true, stockStatus: "IN_STOCK" });
    expect(created.offers).toEqual([{ title: "حبتين بـ 16", quantity: 2, price: 16, saving: 2, remainingQty: null, expiresAt: null }]);
    const links = (await (db as any).catalogProduct.findMany({ where: { catalogId: s.catalog.id } })) as Array<{ productId: string }>;
    expect(links.map((l) => l.productId).sort()).toEqual([s.sameName.id, created.id].sort());
  });

  it("رد فاضي أو صفحة ممتلئة = ولا منتج بيتوقف (انقطاع ما بيمسح الكتالوج)", async () => {
    const s = await seed();
    await connect();
    omsProducts = [];
    const empty = await syncProductsFromOms(db as unknown as Db, ACTOR);
    expect(empty).toMatchObject({ deactivated: 0, deactivationSkipped: "EMPTY" });

    omsProducts = Array.from({ length: 500 }, (_, i) => ({ code: `P${i}`, name: `منتج ${i}`, price: "1.00", currency: "USD", offers: [], complements: [] }));
    const full = await syncProductsFromOms(db as unknown as Db, ACTOR);
    expect(full).toMatchObject({ deactivated: 0, deactivationSkipped: "PAGE_FULL" });
    expect(((await db.product.findUnique({ where: { id: s.localOnly.id } })) as any).isActive).toBe(true);
  });

  it("منتج من الـ OMS: أسعار مسمّاة قديمة عندنا ما بتوصل للذكاء (السعر والعروض من الـ OMS بس)", async () => {
    const p = await createProduct(db as unknown as Db, ACTOR, {
      name: "منتج الطنين",
      sku: "TIN01",
      price: 10,
      currency: "USD",
      priceTiers: [{ label: "عرض قديم", price: "8" }],
    } as never);
    const before = await buildProductContext(db as unknown as Db, WS, p.id);
    expect(before.product.priceTiers).toHaveLength(1);

    await connect();
    omsProducts = [{ code: "TIN01", name: "منتج الطنين", price: "15.00", currency: "USD", offers: [], complements: [] }];
    await syncProductsFromOms(db as unknown as Db, ACTOR);
    const after = await buildProductContext(db as unknown as Db, WS, p.id);
    expect(after.product.priceTiers).toEqual([]);
    expect(Number(after.product.price)).toBe(15);
  });

  it("توكن مرفوض = ولا تغيير بالمنتجات", async () => {
    const s = await seed();
    await saveOmsConnection(db as unknown as Db, ACTOR, { baseUrl: OMS_URL, token: "zk1_wrong_token_value" });
    await expect(syncProductsFromOms(db as unknown as Db, ACTOR)).rejects.toMatchObject({ code: "OMS_AUTH_FAILED" });
    expect(((await db.product.findUnique({ where: { id: s.localOnly.id } })) as any).isActive).toBe(true);
  });
});

describe("كل طلب مؤكد بينزل بالـ OMS", () => {
  async function confirmedOrder(phone = "0930000000") {
    const product = await createProduct(db as unknown as Db, ACTOR, { name: "منتج الطنين", sku: "TIN01", price: 15, currency: "USD" });
    const customer = (await db.customer.create({ data: { workspaceId: WS, name: "محمد", phone, status: "INTERESTED" } } as never)) as { id: string };
    await db.channel.create({ data: { id: "ch-1", workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-1" } } as never);
    await db.channelAccount.create({
      data: { channelId: "ch-1", provider: "FACEBOOK", externalAccountId: "page-1", pageName: "P", encryptedCredentials: encryptSecret("t") },
    } as never);
    const conv = (await db.conversation.create({
      data: { workspaceId: WS, customerId: customer.id, channelId: "ch-1", channelConversationId: "fb-conv-1" },
    } as never)) as { id: string };
    await updateDraftFromExtraction(db as unknown as Db, {
      workspaceId: WS,
      conversationId: conv.id,
      customerId: customer.id,
      extraction: { productId: product.id, quantity: 2, phone, rawAddress: "الفرقان", province: "حلب", customerName: "محمد" } as never,
      source: "TEST",
    });
    const draft = (await db.orderDraft.findFirst({ where: { conversationId: conv.id } })) as { id: string };
    const res = await createOrderFromDraft(db as unknown as Db, ACTOR, { draftId: draft.id });
    return res.orderId;
  }

  it("إنشاء الطلب بيحط مهمة إرسال بمفتاح فيه المساحة — والمهمة بتنزّله بالـ OMS مرة وحدة", async () => {
    await connect(true);
    const orderId = await confirmedOrder();
    const jobs = (await db.backgroundJob.findMany({ where: { type: "handoff_order_to_oms" } as never })) as Array<{ idempotencyKey: string; payload: any }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotencyKey).toBe(autoHandoffKey(WS, orderId));
    expect(jobs[0].idempotencyKey).toContain(WS);

    expect(await handleAutoHandoffJob(db as unknown as Db, jobs[0].payload, WS)).toEqual({ success: true });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v1/orders");
    expect(post?.headers["idempotency-key"]).toBe(omsIdempotencyKey(WS, orderId));
    expect(post?.body).toMatchObject({
      source: "replies",
      customer: { name: "محمد", phone: "0930000000", city: "حلب", address: "الفرقان" },
      items: [{ product_code: "TIN01", quantity: 2, unit_price: "15.00" }],
    });
    const order = (await db.order.findUnique({ where: { id: orderId } })) as any;
    expect(order).toMatchObject({ omsOrderId: "oms-ord-1", omsOrderNumber: "SY-2026-0148", handoffMode: "api" });

    // إعادة = ولا نداء تاني.
    await handoffOrderToOms(db as unknown as Db, ACTOR, orderId);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("الإرسال التلقائي مطفي = ولا مهمة (والطلب بينبعت يدويًا)", async () => {
    await connect(false);
    const orderId = await confirmedOrder();
    expect(await db.backgroundJob.findMany({ where: { type: "handoff_order_to_oms" } as never })).toHaveLength(0);
    const r = await handoffOrderToOms(db as unknown as Db, ACTOR, orderId);
    expect(r).toMatchObject({ handedOff: true, omsOrderNumber: "SY-2026-0148" });
  });

  it("رفض نهائي من الـ OMS (منتج مش عنده) = ولا إعادة، والسبب بينحفظ", async () => {
    await connect(true);
    orderAnswer = () => Response.json({ error: { code: "PRODUCT_UNKNOWN", message: "x" } }, { status: 422 });
    const orderId = await confirmedOrder();
    expect(await handleAutoHandoffJob(db as unknown as Db, { orderId }, WS)).toEqual({ success: true });
    const audit = (await (db as any).auditLog.findFirst({ where: { entityId: orderId, action: "oms.auto_handoff_refused" } })) as any;
    expect(audit?.metadata?.code).toBe("OMS_REJECTED");
    expect(String(audit?.metadata?.reason)).toContain("PRODUCT_UNKNOWN");
    expect(((await db.order.findUnique({ where: { id: orderId } })) as any).omsOrderId ?? null).toBeNull();
  });

  it("الـ OMS واقف (500) = المهمة بتفشل وبتنعاد", async () => {
    await connect(true);
    orderAnswer = () => Response.json({ error: { code: "INTERNAL" } }, { status: 500 });
    const orderId = await confirmedOrder();
    expect(await handleAutoHandoffJob(db as unknown as Db, { orderId }, WS)).toEqual({ success: false, error: "OMS_ERROR" });
  });

  it("السعر المعدّل من الـ OMS بينحفظ بالسجل", async () => {
    await connect(false);
    orderAnswer = () =>
      Response.json(
        { order_id: "oms-ord-2", order_number: "SY-2026-0149", status: "NEW", price_adjusted: true, totals: { total: "40.00", currency: "USD" } },
        { status: 201 }
      );
    const orderId = await confirmedOrder();
    const r = await handoffOrderToOms(db as unknown as Db, ACTOR, orderId);
    expect(r.priceAdjusted).toBe(true);
    const audit = (await (db as any).auditLog.findFirst({ where: { entityId: orderId, action: "oms.order_handed_off" } })) as any;
    expect(audit?.metadata).toMatchObject({ priceAdjusted: true, omsTotal: 40, omsCurrency: "USD" });
  });
});
