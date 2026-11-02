/**
 * قبول إصلاح الموثوقية والأداء — Phase 1 + Phase 2.
 *
 * يثبت على مسار الكود الفعلي:
 *  - Phase 2: حارس الإرسال — استلام الموظف (HUMAN_ACTIVE) يوقف كل رد آلي
 *    (AI · أتمتة · متابعة · نظام · حملة على محادثة زبون)، ويسمح بالرد اليدوي
 *    وببثّ الحملة على سلسلة يملكها النظام فقط، ووضع التجميع (COLLECTION_ONLY)
 *    يوقف كل الإرسال الآلي.
 *  - Phase 0.2: سياق الكمية — كلمة خارج سياق الطلب ما بتنشئ طلب، وداخل
 *    سياق تحديد الكمية بتتحوّل لرقم صحيح.
 *  - Phase 1.1: تأكيد متزامن لنفس المسودة = طلب واحد فقط (لا 500 ولا تكرار).
 *  - Phase 1.6: إلغاء الطلب ينشر حدث OrderCancelled (لا ConversationUpdated).
 *  - Phase 1.4/1.5: تعديل المحافظة يحافظ على الخصم ويعيد احتساب التوصيل،
 *    ومحافظة غير معرّفة عند وجود قواعد توصيل = غير متاحة (ليست مجانية).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { assertAutomatedSendAllowed, loadConversationSendPolicy } from "@/modules/channels/send-policy";
import { eventBus } from "@/core/events/bus";
import { createProduct } from "@/modules/products/service";
import { upsertDeliveryRule } from "@/modules/orders/delivery";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft, transitionOrder, updateOrderFromChat } from "@/modules/orders/order-service";
import { parseQuantity } from "@/modules/orders/primitives";
import { handleOrderIntent } from "@/modules/orders/intelligence";

const WS_A = "ws-a";
const AGENT = { userId: "agent-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

let db: FakeDb;
let productId: string;
let conversationId: string;
let customerId: string;

async function seedWorld(opts: { sendMode?: string; aiState?: string } = {}) {
  db = createFakeDb() as FakeDb;
  const product = await createProduct(db as Db, AGENT, {
    name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP",
  });
  productId = product.id;
  db._stores.channel.push({
    id: "ch-1",
    workspaceId: WS_A,
    type: "FACEBOOK",
    status: "CONNECTED",
    displayName: "صفحة الاختبار",
    sendMode: opts.sendMode ?? "AUTO_REPLY",
  });
  const customer = await db.customer.create({
    data: { workspaceId: WS_A, name: "محمد", phone: "0930000000", status: "INTERESTED" },
  } as never);
  customerId = customer.id;
  const conv = await db.conversation.create({
    data: {
      workspaceId: WS_A,
      customerId,
      channelId: "ch-1",
      channelConversationId: "fb-conv-1",
      aiState: opts.aiState ?? "AI_ACTIVE",
    },
  } as never);
  conversationId = conv.id;
  // Force relation attachment (channel) so the send-policy read reflects the
  // real channel row — mirrors what an inbound message does in production.
  await db.conversation.findFirst({ where: { id: conversationId } });
}

async function makeDraft(quantity = 2) {
  await updateDraftFromExtraction(db as Db, {
    workspaceId: WS_A,
    conversationId,
    customerId,
    extraction: { productId, quantity, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
    source: "TEST",
  });
  const draft = (await db.orderDraft.findUniqueOrThrow({ where: { conversationId } })) as unknown as { id: string };
  return draft;
}

beforeEach(async () => {
  await seedWorld();
});

// ── Phase 2 — حارس الإرسال واستلام الموظف ────────────────────────────────

describe("Phase 2 — حارس الإرسال الآلي واستلام الموظف", () => {
  it("يقرأ الوضع والحالة باستعلام واحد", async () => {
    const policy = await loadConversationSendPolicy(db as never, { workspaceId: WS_A, conversationId });
    expect(policy.mode).toBe("AUTO_REPLY");
    expect(policy.aiState).toBe("AI_ACTIVE");
  });

  it("HUMAN_ACTIVE يوقف كل رد آلي (AI · أتمتة · متابعة · نظام)", async () => {
    await db.conversation.update({ where: { id: conversationId }, data: { aiState: "HUMAN_ACTIVE" } } as never);
    for (const source of ["AI", "AUTOMATION", "FOLLOWUP", "SYSTEM"]) {
      const decision = await assertAutomatedSendAllowed(db as never, {
        workspaceId: WS_A,
        conversationId,
        senderType: source,
      });
      expect(decision.allowed, `source=${source}`).toBe(false);
      if (!decision.allowed) expect(decision.reason, `source=${source}`).toBe("HUMAN_ACTIVE");
    }
  });

  it("HUMAN_ACTIVE يسمح بالرد اليدوي ويرفض الحملة على محادثة زبون استلمها موظف", async () => {
    await db.conversation.update({ where: { id: conversationId }, data: { aiState: "HUMAN_ACTIVE" } } as never);
    const human = await assertAutomatedSendAllowed(db as never, {
      workspaceId: WS_A, conversationId, senderType: "HUMAN",
    });
    expect(human.allowed).toBe(true);

    // محادثة زبون حقيقية (channelConversationId «fb-conv-1») استلمها الموظف →
    // حتى الحملة تُرفض: ما بيوصل بثّ تسويقي على محادثة بيد الموظف.
    const campaign = await assertAutomatedSendAllowed(db as never, {
      workspaceId: WS_A, conversationId, senderType: "CAMPAIGN",
    });
    expect(campaign.allowed).toBe(false);
    if (!campaign.allowed) expect(campaign.reason).toBe("HUMAN_ACTIVE");
  });

  it("الحملة تُبثّ على سلسلة يملكها النظام (camp-…) حتى لو كانت HUMAN_ACTIVE", async () => {
    // سلسلة الحملة: aiState HUMAN_ACTIVE + aiEnabled false — قناة بثّ مقصودة،
    // مش محادثة زبون. البثّ مسموح هنا فقط، ومصدره صادق (CAMPAIGN مش HUMAN).
    db._stores.conversation.push({
      id: "cv-campaign",
      workspaceId: WS_A,
      customerId,
      channelId: "ch-1",
      channelConversationId: "camp-c1-cust9",
      aiState: "HUMAN_ACTIVE",
      aiEnabled: false,
    });
    await db.conversation.findFirst({ where: { id: "cv-campaign" } });

    const campaign = await assertAutomatedSendAllowed(db as never, {
      workspaceId: WS_A, conversationId: "cv-campaign", senderType: "CAMPAIGN",
    });
    expect(campaign.allowed).toBe(true);

    // ونفس السلسلة ترفض الرد الآلي العادي (AI) — البثّ وحده مستثنى.
    const ai = await assertAutomatedSendAllowed(db as never, {
      workspaceId: WS_A, conversationId: "cv-campaign", senderType: "AI",
    });
    expect(ai.allowed).toBe(false);
    if (!ai.allowed) expect(ai.reason).toBe("HUMAN_ACTIVE");
  });

  it("COLLECTION_ONLY يوقف الآلي وحتى بثّ الحملة", async () => {
    await db.conversation.update({ where: { id: conversationId }, data: { aiState: "AI_ACTIVE" } } as never);
    await db.channel.update({ where: { id: "ch-1" }, data: { sendMode: "COLLECTION_ONLY" } } as never);

    const ai = await assertAutomatedSendAllowed(db as never, { workspaceId: WS_A, conversationId, senderType: "AI" });
    expect(ai.allowed).toBe(false);
    if (!ai.allowed) expect(ai.reason).toBe("COLLECTION_ONLY");

    const campaign = await assertAutomatedSendAllowed(db as never, {
      workspaceId: WS_A, conversationId, senderType: "CAMPAIGN",
    });
    expect(campaign.allowed).toBe(false);
    if (!campaign.allowed) expect(campaign.reason).toBe("COLLECTION_ONLY");
  });

  it("وضع غير معروف = رفض آمن", async () => {
    db._stores.conversation.push({
      id: "cv-ghost", workspaceId: WS_A, customerId, channelId: "ghost", channelConversationId: "g",
    });
    const decision = await assertAutomatedSendAllowed(db as never, {
      workspaceId: WS_A, conversationId: "cv-ghost", senderType: "AI",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("SEND_MODE_UNKNOWN");
  });

  it("عزل المساحة: محادثة مساحة أخرى لا تمرّ", async () => {
    const decision = await assertAutomatedSendAllowed(db as never, {
      workspaceId: "ws-other", conversationId, senderType: "AI",
    });
    expect(decision.allowed).toBe(false);
  });
});

// ── Phase 1.1 — تأكيد متزامن = طلب واحد ────────────────────────────────

describe("Phase 1.1 — تأكيد متزامن لنفس المسودة", () => {
  it("طلبان متزامنان ينتجان طلبًا واحدًا فقط (مفتاح عدم التكرار)", async () => {
    const draft = await makeDraft(3);
    const [a, b] = await Promise.all([
      createOrderFromDraft(db as Db, AGENT, { draftId: draft.id }),
      createOrderFromDraft(db as Db, AGENT, { draftId: draft.id }),
    ]);
    expect(a.orderId).toBe(b.orderId);
    expect((db._stores.order as unknown[])).toHaveLength(1);
    // الطلب الأول created=true، والثاني يرى النتيجة الموجودة (created=false).
    expect(a.created || b.created).toBe(true);
    expect(a.created && b.created).toBe(false);
  });
});

// ── Phase 1.6 — حدث الإلغاء ─────────────────────────────────────────────

describe("Phase 1.6 — إلغاء الطلب ينشر حدث الحالة الصحيح", () => {
  it("ينشر OrderCancelled ولا ينشر ConversationUpdated", async () => {
    const draft = await makeDraft(2);
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });

    const seen: string[] = [];
    const offCancel = eventBus.subscribe("OrderCancelled", () => seen.push("OrderCancelled"));
    const offConvo = eventBus.subscribe("ConversationUpdated", () => seen.push("ConversationUpdated"));

    await transitionOrder(db as Db, AGENT, created.orderId, "CANCELLED");

    offCancel();
    offConvo();
    expect(seen).toContain("OrderCancelled");
    expect(seen).not.toContain("ConversationUpdated");
  });
});

// ── Phase 1.4/1.5 — سلامة السعر والعنوان ────────────────────────────────

describe("Phase 1.4/1.5 — تعديل المحافظة والخصم", () => {
  async function seedEditableOrder(over: Record<string, unknown> = {}) {
    const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    const order = await db.order.create({
      data: {
        workspaceId: WS_A,
        orderNumber: "ORD-EDIT-1",
        customerId,
        conversationId,
        status: "NEW",
        confirmationStatus: "PENDING",
        deliveryAddress: "دويلعة",
        province: "دمشق",
        subtotal: 300000,
        discount: 20000,
        deliveryFee: 50000,
        total: 330000,
        currency: "SYP",
        source: "AI",
        idempotencyKey: "edit-1",
        ...over,
      },
    } as never);
    await db.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        productNameSnapshot: "ماء الكمأة",
        skuSnapshot: "TW-500",
        unitPrice: 150000,
        quantity: 2,
        subtotal: 300000,
      },
    } as never);
    void customer;
    return order;
  }

  it("تعديل المحافظة يحافظ على الخصم ويعيد احتساب التوصيل فقط", async () => {
    const order = await seedEditableOrder();
    await upsertDeliveryRule(db as Db, WS_A, { province: "حلب", fee: 70000 });

    const res = await updateOrderFromChat(db as Db, AGENT, {
      conversationId,
      province: "حلب",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // المجموع = المجموع الفرعي − الخصم + التوصيل الجديد (لا يُسقط الخصم).
      expect(Number(res.order.deliveryFee)).toBe(70000);
      expect(Number(res.order.discount)).toBe(20000);
      expect(Number(res.order.total)).toBe(300000 - 20000 + 70000);
    }
    void order;
  });

  it("محافظة غير معرّفة مع وجود قواعد توصيل = غير متاحة", async () => {
    await seedEditableOrder();
    await upsertDeliveryRule(db as Db, WS_A, { province: "دمشق", fee: 50000 });

    await expect(
      updateOrderFromChat(db as Db, AGENT, { conversationId, province: "لندن" })
    ).rejects.toMatchObject({ code: "DELIVERY_UNAVAILABLE" });
  });

  it("طلب مؤكد لا يُعدّل من المحادثة ويُسجّل طلب تعديل", async () => {
    await seedEditableOrder({ status: "CONFIRMED", idempotencyKey: "edit-2", orderNumber: "ORD-EDIT-2" });
    const res = await updateOrderFromChat(db as Db, AGENT, { conversationId, province: "حلب" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NOT_EDITABLE");
    const audits = (db._stores.auditLog as Array<Record<string, any>>).filter(
      (a) => a.action === "order.edit_requested"
    );
    expect(audits.length).toBeGreaterThan(0);
  });
});

// ── Phase 0.2 — سياق الكمية: لا طلب من كلمة خارج السياق ──────────────────

describe("Phase 0.2 — الكمية داخل سياق الطلب وخارجه", () => {
  it("«عشرين» داخل تحديد الكمية = 20، و«يوم الاثنين/استفسار/LG50» مش كمية", () => {
    expect(parseQuantity("بدي عشرين قطعة").value).toBe(20);
    expect(parseQuantity("عشرين").value).toBe(20);
    expect(parseQuantity("يوم الاثنين").value).toBeNull();
    expect(parseQuantity("عندي استفسار").value).toBeNull();
    expect(parseQuantity("LG50").value).toBeNull();
  });

  it("«عشرين» بلا نية طلب وبلا مسودة = ما بتنشئ طلب ولا مسودة", async () => {
    const res = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { intent: "UNKNOWN", confidence: 0.2, language: "ar", entities: {}, missingFields: [], memories: [] },
      customerText: "عشرين",
    });
    expect(res.handled).toBe(false);
    expect(res.action).toBe("NONE");
    expect((db._stores.orderDraft as unknown[])).toHaveLength(0);
    expect((db._stores.order as unknown[])).toHaveLength(0);
  });

  it("«بدي عشرين قطعة» داخل نية تحديث الكمية = 20 على المسودة", async () => {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const res = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { intent: "ORDER_UPDATE", confidence: 0.9, language: "ar", entities: {}, missingFields: [], memories: [], requestedAction: "CREATE_ORDER" },
      customerText: "بدي عشرين قطعة",
    });
    expect(res.handled).toBe(true);
    const draft = (await db.orderDraft.findUniqueOrThrow({ where: { conversationId } })) as unknown as { quantity: number | null };
    expect(draft.quantity).toBe(20);
  });
});
