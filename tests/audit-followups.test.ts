/**
 * إصلاحات ملاحظات الفحص المتبقية.
 * ⚠️ قاعدة بالذاكرة وتلجرام وهمي — سلوك لا اتصال حقيقي.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { catalogListQuerySchema } from "@/modules/catalog/schemas";
import { pickBestProductMatch, productSearchWords } from "@/modules/ai/product-match";
import { createProduct, redactProductForActor } from "@/modules/products/service";
import { customerFacingPriceTiers } from "@/modules/products/price-tiers";
import { listOpenDrafts, updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft, deleteOrder, updateOrderFromChat } from "@/modules/orders/order-service";
import { deliverOrderTelegram } from "@/modules/orders/telegram-delivery";
import { runJobs } from "@/modules/jobs/handlers";
import { TelegramClient, setTelegramClientFactory } from "@/modules/channels/telegram/client";
import { encryptSecret } from "@/core/crypto";
import { retrieveKnowledge } from "@/modules/knowledge/retriever";
import { createKnowledgeDocument, updateDocument } from "@/modules/knowledge/service";
import { InMemoryVectorStore, PgVectorStore } from "@/modules/knowledge/vector-store";
import { getCurrentEmbeddingIdentity } from "@/modules/knowledge/embeddings";

type Db = Prisma.TransactionClient;
const WS = "ws-followups";
const AGENT = { userId: "agent-f", workspaceId: WS };

describe("فلتر الكتالوجات", () => {
  it("isActive=false بيرجع false مش true", () => {
    expect(catalogListQuerySchema.parse({ isActive: "false" }).isActive).toBe(false);
    expect(catalogListQuerySchema.parse({ isActive: "true" }).isActive).toBe(true);
    expect(catalogListQuerySchema.parse({}).isActive).toBeUndefined();
  });
});

describe("مطابقة المنتج من كلام الزبون", () => {
  const products = [
    { id: "water", name: "ماء الكمأة" },
    { id: "honey", name: "عسل الكمأة" },
    { id: "gift", name: "بديع الهدايا" },
    { id: "vit", name: "Vitamin C" },
  ];

  it("بيختار المنتج الأقرب مش أول واحد", () => {
    expect(pickBestProductMatch(productSearchWords("بدي عسل الكمأة"), products)).toBe("honey");
  });

  it("الكلمات الشائعة القصيرة ما بتطابق منتج", () => {
    expect(productSearchWords("بدي سعر شو")).toEqual([]);
    expect(pickBestProductMatch(productSearchWords("بدي"), products)).toBeNull();
  });

  it("لو الكلام بيطابق أكتر من منتج بنفس الدرجة ما منخمّن", () => {
    expect(pickBestProductMatch(productSearchWords("الكمأة"), products)).toBeNull();
  });

  it("الأحرف الإنجليزية ما بتفرق كبيرة أو صغيرة", () => {
    expect(pickBestProductMatch(productSearchWords("VITAMIN please"), products)).toBe("vit");
  });

  it("الاسم الكامل بيغلب اسم أطول بيحتويه", () => {
    const list = [{ id: "a", name: "زيت" }, { id: "b", name: "زيت الكمأة" }];
    expect(pickBestProductMatch(["زيت"], list)).toBe("a");
  });
});

describe("أسعار الجملة", () => {
  const tiers = [
    { label: "سعر الجملة", price: "8" },
    { label: "سعر الموزع", price: "6" },
    { label: "Wholesale", price: "7" },
    { label: "عرض الأربعاء", price: "9" },
  ];

  it("ما بتوصل للذكاء اللي بيرد على الزبون", () => {
    expect(customerFacingPriceTiers(tiers)).toEqual([{ label: "عرض الأربعاء", price: "9" }]);
  });

  it("بتنخفى بالـ API عن اللي ما عنده صلاحية الجملة", () => {
    const noAccess = { can: () => false };
    const full = { can: () => true };
    expect(redactProductForActor({ priceTiers: tiers }, noAccess).priceTiers).toEqual([{ label: "عرض الأربعاء", price: "9" }]);
    expect(redactProductForActor({ priceTiers: tiers }, full).priceTiers).toHaveLength(4);
  });
});

describe("كتابة الطلب والمنتج كعملية وحدة", () => {
  let db: any;

  beforeEach(() => {
    db = createFakeDb();
  });

  it("فشل حذف الطلب ما بيمسح بنوده", async () => {
    await db.workspaceMember.create({ data: { workspaceId: WS, userId: "owner-f", role: "OWNER", status: "ACTIVE" } });
    const customer = await db.customer.create({ data: { workspaceId: WS, name: "س" } });
    const order = await db.order.create({
      data: { workspaceId: WS, customerId: customer.id, orderNumber: "ORD-D", status: "NEW", subtotal: 1, discount: 0, deliveryFee: 0, total: 1, currency: "USD" },
    });
    await db.orderItem.create({ data: { orderId: order.id, productNameSnapshot: "x", skuSnapshot: "x", unitPrice: 1, quantity: 1, subtotal: 1 } });
    db.order.delete = async () => {
      throw new Error("db down");
    };
    await expect(deleteOrder(db as Db, { userId: "owner-f", workspaceId: WS }, order.id)).rejects.toThrow("db down");
    expect(await db.orderItem.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("فشل حفظ الأسعار الإضافية ما بيترك منتج ناقص", async () => {
    db.productPrice.createMany = async () => {
      throw new Error("db down");
    };
    await expect(
      createProduct(db as Db, AGENT, { name: "منتج", sku: "ATOM-1", price: 5, priceTiers: [{ label: "عرض", price: "4" }] })
    ).rejects.toThrow("db down");
    expect(await db.product.count({ where: { workspaceId: WS } })).toBe(0);
  });

  it("سباق على نفس SKU بيرجع 409 مش خطأ 500", async () => {
    db.product.create = async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    };
    await expect(createProduct(db as Db, AGENT, { name: "منتج", sku: "RACE-1", price: 5 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("تعديل الكمية من المحادثة: فشل تحديث الطلب بيرجّع البند كما كان", async () => {
    const customer = await db.customer.create({ data: { workspaceId: WS, name: "س" } });
    const order = await db.order.create({
      data: { workspaceId: WS, customerId: customer.id, conversationId: "conv-e", orderNumber: "ORD-E", status: "NEW", subtotal: 10, discount: 0, deliveryFee: 0, total: 10, currency: "USD" },
    });
    await db.orderItem.create({ data: { orderId: order.id, productNameSnapshot: "x", skuSnapshot: "x", unitPrice: 10, quantity: 1, subtotal: 10 } });
    db.order.update = async () => {
      throw new Error("db down");
    };
    await expect(updateOrderFromChat(db as Db, AGENT, { conversationId: "conv-e", quantity: 3 })).rejects.toThrow("db down");
    const [item] = await db.orderItem.findMany({ where: { orderId: order.id } });
    expect(item.quantity).toBe(1);
  });

  it("تغيير الهاتف من المحادثة بيتحدّث على الطلب نفسه", async () => {
    const customer = await db.customer.create({ data: { workspaceId: WS, name: "س", phone: "0790000000" } });
    await db.order.create({
      data: { workspaceId: WS, customerId: customer.id, conversationId: "conv-p", orderNumber: "ORD-P", status: "NEW", subtotal: 10, discount: 0, deliveryFee: 0, total: 10, currency: "USD", recipientPhone: "0790000000" },
    });
    const res = await updateOrderFromChat(db as Db, AGENT, { conversationId: "conv-p", phone: "0791111111" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.order.recipientPhone).toBe("0791111111");
      expect(res.changed).toContain("phone");
    }
  });
});

describe("طلب من مسودة: المتغيرات وإشعار تلجرام", () => {
  let db: any;
  let productId: string;
  let conversationId: string;
  let customerId: string;

  beforeEach(async () => {
    db = createFakeDb();
    const product = (await createProduct(db as Db, AGENT, { name: "ماء الكمأة", sku: "VAR-A", price: 100, currency: "USD" })) as { id: string };
    productId = product.id;
    customerId = ((await db.customer.create({
      data: { workspaceId: WS, name: "سامر", phone: "0791234567", address: "عمان", province: "عمان" },
    })) as { id: string }).id;
    const channel = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "ص", externalId: "page-v", sendMode: "AUTO_REPLY", orderRequiredFields: ["product", "quantity", "phone", "address"] },
    })) as { id: string };
    conversationId = ((await db.conversation.create({
      data: { workspaceId: WS, customerId, channelId: channel.id, channelConversationId: "conv-v" },
    })) as { id: string }).id;
    await updateDraftFromExtraction(db as Db, { workspaceId: WS, conversationId, customerId, extraction: { productName: "ماء الكمأة", quantity: 2 }, source: "TEST" });
  });

  async function draftWithVariant(variantId: string) {
    const [d] = (await listOpenDrafts(db as Db, WS, conversationId)) as any[];
    const items = [{ productId, productName: "ماء الكمأة", variantId, quantity: 2 }];
    return db.orderDraft.update({ where: { id: d.id }, data: { items, variantId } });
  }

  it("المتغير الصحيح بيتسعّر بسعره", async () => {
    const variant = await db.productVariant.create({ data: { productId, name: "كبير", sku: "VAR-A-L", price: 150 } });
    const d = await draftWithVariant(variant.id);
    const r = await createOrderFromDraft(db as Db, AGENT, { draftId: d.id });
    const [item] = await db.orderItem.findMany({ where: { orderId: r.orderId } });
    expect(Number(item.unitPrice)).toBe(150);
    expect(item.variantId).toBe(variant.id);
  });

  it("متغير مش تابع للمنتج بيتجاهل وبيرجع لسعر المنتج", async () => {
    const other = (await createProduct(db as Db, AGENT, { name: "عسل", sku: "VAR-B", price: 900, currency: "USD" })) as { id: string };
    const foreign = await db.productVariant.create({ data: { productId: other.id, name: "ك", sku: "VAR-B-L", price: 999 } });
    const d = await draftWithVariant(foreign.id);
    const r = await createOrderFromDraft(db as Db, AGENT, { draftId: d.id });
    const [item] = await db.orderItem.findMany({ where: { orderId: r.orderId } });
    expect(Number(item.unitPrice)).toBe(100);
    expect(item.variantId).toBeNull();
  });

  function telegramClient(fail: () => boolean) {
    const calls: unknown[] = [];
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async (_url: string, init: { body?: string }) => {
            if (fail()) return new Response("{}", { status: 500 });
            calls.push(init?.body);
            return Response.json({ ok: true, result: { message_id: 7 } });
          }) as unknown as typeof fetch,
        })
    );
    return calls;
  }

  async function enableTelegram() {
    await db.telegramOrderSettings.create({
      data: { workspaceId: WS, enabled: true, botTokenEnc: encryptSecret("123456:TEST_TOKEN"), chatId: "-100", topicId: "42" },
    });
  }

  it("فشل تلجرام بيحفظ مهمة إعادة محاولة، والإعادة بترسل مرة وحدة", async () => {
    await enableTelegram();
    let down = true;
    const calls = telegramClient(() => down);
    const [d] = (await listOpenDrafts(db as Db, WS, conversationId)) as any[];
    const r = await createOrderFromDraft(db as Db, AGENT, { draftId: d.id });

    const jobs = (db._stores.backgroundJob as any[]).filter((j) => j.type === "notify_order_telegram");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ orderId: r.orderId });

    down = false;
    await db.backgroundJob.update({ where: { id: jobs[0].id }, data: { runAfter: new Date(0) } });
    await runJobs(db as never, { limit: 10, maintenance: false });
    expect((db._stores.backgroundJob as any[]).find((j) => j.id === jobs[0].id).status).toBe("DONE");
    await deliverOrderTelegram(db as Db, { workspaceId: WS, userId: AGENT.userId, orderId: r.orderId });
    expect(calls).toHaveLength(1);
  });

  it("نجاح تلجرام من أول مرة ما بيضيف مهمة", async () => {
    await enableTelegram();
    telegramClient(() => false);
    const [d] = (await listOpenDrafts(db as Db, WS, conversationId)) as any[];
    await createOrderFromDraft(db as Db, AGENT, { draftId: d.id });
    expect((db._stores.backgroundJob as any[]).filter((j) => j.type === "notify_order_telegram")).toHaveLength(0);
  });
});

describe("مستندات المعرفة حسب منتجات الصفحة", () => {
  let db: any;
  let inId: string;
  let outId: string;

  const identity = () => getCurrentEmbeddingIdentity();
  function store(rows: { id: string; documentId: string }[]) {
    const id = identity();
    return new InMemoryVectorStore(
      new Map(rows.map((r) => [r.id, [1, 0]])),
      new Map(
        rows.map((r) => [
          r.id,
          { documentId: r.documentId, content: r.id, workspaceId: WS, metadata: {}, isActive: true, embeddingProvider: id.provider, embeddingModel: id.model, embeddingDimensions: id.dimensions },
        ])
      )
    );
  }

  beforeEach(async () => {
    db = createFakeDb();
    inId = ((await createProduct(db as Db, AGENT, { name: "داخل", sku: "K-IN", price: 1 })) as { id: string }).id;
    outId = ((await createProduct(db as Db, AGENT, { name: "خارج", sku: "K-OUT", price: 1 })) as { id: string }).id;
  });

  async function docs() {
    const general = await createKnowledgeDocument(db as Db, AGENT, { title: "عام", content: "x" });
    const inside = await createKnowledgeDocument(db as Db, AGENT, { title: "داخل", content: "x", productId: inId });
    const outside = await createKnowledgeDocument(db as Db, AGENT, { title: "خارج", content: "x", productId: outId });
    return { general, inside, outside };
  }

  it("مستند منتج خارج كتالوج الصفحة ما بيوصل للرد", async () => {
    const d = await docs();
    const vs = store([
      { id: "c-g", documentId: d.general.id },
      { id: "c-i", documentId: d.inside.id },
      { id: "c-o", documentId: d.outside.id },
    ]);
    const out = await retrieveKnowledge(db as Db, vs, { workspaceId: WS, query: "سؤال", allowedProductIds: [inId] });
    expect(out.chunks.map((c) => c.chunkId).sort()).toEqual(["c-g", "c-i"]);
  });

  it("صفحة بلا كتالوجات بتشوف كل المستندات", async () => {
    const d = await docs();
    const vs = store([{ id: "c-o", documentId: d.outside.id }]);
    const out = await retrieveKnowledge(db as Db, vs, { workspaceId: WS, query: "سؤال" });
    expect(out.chunks).toHaveLength(1);
  });

  it("ما بينربط مستند بمنتج من مساحة تانية", async () => {
    const foreign = (await createProduct(db as Db, { userId: "x", workspaceId: "ws-other" }, { name: "غريب", sku: "K-F", price: 1 })) as { id: string };
    await expect(createKnowledgeDocument(db as Db, AGENT, { title: "ت", content: "x", productId: foreign.id })).rejects.toMatchObject({ statusCode: 404 });
    const doc = await createKnowledgeDocument(db as Db, AGENT, { title: "ت", content: "x" });
    await expect(updateDocument(db as Db, AGENT, doc.id, { productId: foreign.id })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("فلاتر pgvector بتنفّذ بالـ SQL نفسه", async () => {
    let captured = { sql: "", params: [] as unknown[] };
    const pg = new PgVectorStore(async (sql, params) => {
      captured = { sql, params };
      return [];
    });
    await pg.search({ embedding: [1], workspaceId: WS, excludeDocumentIds: ["d1"], metadataFilters: { category: "FAQ" } });
    expect(captured.sql).toContain('c."documentId" = ANY');
    expect(captured.sql).toContain("c.metadata->>");
    expect(captured.params).toEqual(expect.arrayContaining([["d1"], "category", "FAQ"]));
  });
});
