import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { normalizePhone, parseQuantity, parseConfirmation, resolveProduct, toWesternDigits } from "@/modules/orders/primitives";
import { canTransitionOrder, assertOrderTransition, canTransitionDraft } from "@/modules/orders/state-machine";
import { calculatePricing, formatOrderSummary } from "@/modules/orders/pricing";
import { upsertDeliveryRule } from "@/modules/orders/delivery";
import { updateDraftFromExtraction, computeMissingFields } from "@/modules/orders/draft-service";
import { evaluateOrderRules, aggregateVerdict, detectDuplicate } from "@/modules/orders/rules";
import { createOrderFromDraft, transitionOrder, mergeCustomerData, getOwnedOrder } from "@/modules/orders/order-service";
import { handleOrderIntent } from "@/modules/orders/intelligence";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { processIncomingMessage } from "@/modules/conversations/service";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { createProduct } from "@/modules/products/service";
import { AppError } from "@/core/errors";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";

const WS_A = "ws-a";
const WS_B = "ws-b";
const AGENT = { userId: "agent-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let productId: string;
let conversationId: string;
let customerId: string;

async function seedWorld() {
  db = createFakeDb();
  const product = await createProduct(db as Db, AGENT, {
    name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP",
  });
  productId = product.id;
  const customer = await db.customer.create({
    data: { workspaceId: WS_A, name: "محمد", phone: "0930000000", status: "INTERESTED" },
  } as never);
  customerId = customer.id;
  // Production-faithful channel fixtures so outbound honestly succeeds.
  const ch = (await db.channel.create({
    data: { id: "ch-1", workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "Demo Page", externalId: "page-1" },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "Demo Page",
      encryptedCredentials: encryptSecret("page-token-test"),
    },
  } as never);
  await db.channelIdentity.create({
    data: { workspaceId: WS_A, customerId, channelType: "FACEBOOK", channelExternalId: "fb-conv-1" },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let body: any = null;
            try {
              body = JSON.parse(String((init as any)?.body ?? ""));
            } catch { /* ignore */ }
            const recipientId = body?.recipient?.id ?? "psid";
            return Response.json({ recipient_id: recipientId, message_id: `mid-${recipientId}` });
          }
          return Response.json({ id: "page-1", name: "Demo" });
        }) as typeof fetch,
      })
  );
  const conv = await db.conversation.create({
    data: { workspaceId: WS_A, customerId, channelId: "ch-1", channelConversationId: "fb-conv-1" },
  } as never);
  conversationId = conv.id;
}

function emptyStore() {
  return new InMemoryVectorStore(new Map(), new Map());
}

async function readyDraft(overrides: Record<string, unknown> = {}) {
  return updateDraftFromExtraction(db as Db, {
    workspaceId: WS_A,
    conversationId,
    customerId,
    extraction: {
      productId, quantity: 3, phone: "0930000000",
      rawAddress: "دويلعة", province: "دمشق",
      ...overrides,
    },
    source: "TEST",
  });
}

async function draftRow() {
  return db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as {
    id: string; productId: string | null; quantity: number | null; phone: string | null;
    rawAddress: string | null; province: string | null; state: string; missingFields: string[];
  };
}

beforeEach(seedWorld);

describe("Phase 5 — deterministic primitives", () => {
  it("normalizes Arabic and English phone numbers", () => {
    expect(normalizePhone("٠٩٣٠٠٠٠٠٠٠")).toEqual({ valid: true, canonical: "0930000000" });
    expect(normalizePhone("+963 930 000 000").valid).toBe(true);
    expect(normalizePhone("00963930000000").canonical).toBe("0930000000");
    expect(normalizePhone("123").valid).toBe(false);
    expect(toWesternDigits("٣")).toBe("3");
  });

  it("parses quantities: digits, Arabic words, Arabic-Indic numerals", () => {
    expect(parseQuantity("بدي 3").value).toBe(3);
    expect(parseQuantity("٣ قطع").value).toBe(3);
    expect(parseQuantity("ثلاث قطع").value).toBe(3);
    expect(parseQuantity("قطعتين").value).toBe(2);
    expect(parseQuantity("خمسة").value).toBe(5);
    expect(parseQuantity("0").value).toBeNull();
    expect(parseQuantity("-1").value).toBeNull();
    expect(parseQuantity("2.5").reason).toBe("DECIMAL_NOT_ALLOWED");
    expect(parseQuantity("99999", { max: 100 }).reason).toBe("EXCEEDS_MAX");
  });

  it("resolves products: sku, name, normalized, ambiguity", async () => {
    await createProduct(db as Db, AGENT, { name: "ماء الكمأة الأصلي", sku: "TW-ORIG", price: 200000 });
    const list = (await db.product.findMany({})) as any[];
    expect(resolveProduct("TW-500", list).status).toBe("RESOLVED");
    expect(resolveProduct("ماء الكمأة", list).status).toBe("AMBIGUOUS"); // two matches → ask, don't guess
    expect(resolveProduct("ماء التوت", list).status).toBe("NOT_FOUND");
    const single = list.filter((p) => p.sku === "TW-500");
    expect(resolveProduct("ماء الكمأة", single).status).toBe("RESOLVED");
  });

  it("parses confirmation only as a signal (context decided by caller)", () => {
    expect(parseConfirmation("نعم أكد").signal).toBe("YES");
    expect(parseConfirmation("لا إلغاء").signal).toBe("NO");
    expect(parseConfirmation("تمام").signal).toBe("YES");
    expect(parseConfirmation("بدي أسأل عن المنتج تمام الحكي").signal).toBe("NONE");
    expect(parseConfirmation("وين تبيعون؟").signal).toBe("NONE");
  });
});

describe("Phase 5 — state machines", () => {
  it("enforces valid order transitions", () => {
    expect(canTransitionOrder("NEW", "CONFIRMED")).toBe(true);
    expect(canTransitionOrder("CONFIRMED", "PROCESSING")).toBe(true);
    expect(canTransitionOrder("DELIVERED", "NEW")).toBe(false);
    expect(canTransitionOrder("CANCELLED", "CONFIRMED")).toBe(false);
    expect(() => assertOrderTransition("CANCELLED", "CONFIRMED")).toThrow(AppError);
  });

  it("enforces valid draft transitions", () => {
    expect(canTransitionDraft("COLLECTING", "READY")).toBe(true);
    expect(canTransitionDraft("CONVERTED", "COLLECTING")).toBe(false);
  });
});

describe("Phase 5 — pricing & delivery", () => {
  it("calculates price from Product DB (subtotal × qty + delivery)", async () => {
    await upsertDeliveryRule(db as Db, WS_A, { province: "دمشق", fee: 50000 });
    const b = await calculatePricing(db as Db, {
      workspaceId: WS_A, product: { price: 150000, currency: "SYP" }, quantity: 3, province: "دمشق",
    });
    expect(b.subtotal).toBe(450000);
    expect(b.deliveryFee).toBe(50000);
    expect(b.total).toBe(500000);
    expect(b.currency).toBe("SYP");
  });

  it("applies free-over threshold from delivery rules", async () => {
    await upsertDeliveryRule(db as Db, WS_A, { province: "دمشق", fee: 50000, freeOver: 400000 });
    const b = await calculatePricing(db as Db, {
      workspaceId: WS_A, product: { price: 150000, currency: "SYP" }, quantity: 3, province: "دمشق",
    });
    expect(b.deliveryFee).toBe(0);
    expect(b.deliveryReason).toBe("FREE_OVER_THRESHOLD");
  });

  it("marks unavailable provinces and unknown provinces", async () => {
    await upsertDeliveryRule(db as Db, WS_A, { province: "درعا", fee: 0, isAvailable: false });
    const blocked = await calculatePricing(db as Db, {
      workspaceId: WS_A, product: { price: 10, currency: "USD" }, quantity: 1, province: "درعا",
    });
    expect(blocked.deliveryAvailable).toBe(false);
    const unknown = await calculatePricing(db as Db, {
      workspaceId: WS_A, product: { price: 10, currency: "USD" }, quantity: 1, province: "لندن",
    });
    expect(unknown.deliveryAvailable).toBe(true);
    expect(unknown.deliveryReason).toBe("NO_RULE_DEFAULT_FEE");
  });

  it("summary is deterministic — no AI-generated prices", async () => {
    const text = formatOrderSummary({
      productName: "ماء الكمأة", quantity: 3,
      breakdown: { unitPrice: 150000, quantity: 3, subtotal: 450000, discount: 0, deliveryFee: 0, total: 450000, currency: "SYP", deliveryAvailable: true },
      phone: "0930000000", province: "دمشق", address: "دويلعة", customerName: "محمد",
    });
    expect(text).toContain("السعر: 450000 SYP");
    expect(text).toContain("الإجمالي: 450000 SYP");
    expect(text).toContain("التوصيل: مجاني");
  });
});

describe("Phase 5 — order draft", () => {
  it("creates a persisted draft and computes missing fields", async () => {
    const result = await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId }, source: "TEST",
    });
    const draft = await draftRow();
    expect(draft.state).toBe("COLLECTING");
    expect(result.missingFields).toEqual(["quantity", "phone", "address"]);
  });

  it("collects across messages: product then quantity then phone then address", async () => {
    await updateDraftFromExtraction(db as Db, { workspaceId: WS_A, conversationId, customerId, extraction: { productId }, source: "TEST" });
    let draft = await draftRow();
    expect(computeMissingFields(draft)).toContain("quantity");
    await updateDraftFromExtraction(db as Db, { workspaceId: WS_A, conversationId, customerId, extraction: { quantity: 3 }, source: "TEST" });
    draft = await draftRow();
    expect(computeMissingFields(draft)).toEqual(["phone", "address"]);
    await updateDraftFromExtraction(db as Db, { workspaceId: WS_A, conversationId, customerId, extraction: { phone: "٠٩٣٠٠٠٠٠٠٠" }, source: "TEST" });
    draft = await draftRow();
    expect(draft.phone).toBe("0930000000");
    const final = await updateDraftFromExtraction(db as Db, { workspaceId: WS_A, conversationId, customerId, extraction: { rawAddress: "دويلعة", province: "دمشق" }, source: "TEST" });
    expect(final.becameReady).toBe(true);
  });

  it("contextual extraction: order data in one message", async () => {
    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.9, language: "ar",
        entities: { product: "ماء الكمأة", quantity: 3, phone: "0930000000", address: "دويلعة", province: "دمشق" },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي 3",
    });
    expect(result.action).toBe("REQUEST_CONFIRMATION");
  });

  it("invalid phone from AI is dropped, not stored", async () => {
    await updateDraftFromExtraction(db as Db, { workspaceId: WS_A, conversationId, customerId, extraction: { phone: "abc123" }, source: "AI" });
    const draft = await draftRow();
    expect(draft.phone).toBeNull();
  });
});

describe("Phase 5 — rules engine", () => {
  it("REQUIRE_INPUT for missing fields", async () => {
    await updateDraftFromExtraction(db as Db, { workspaceId: WS_A, conversationId, customerId, extraction: { productId }, source: "TEST" });
    const draft = await draftRow();
    const rules = await evaluateOrderRules(db as Db, {
      workspaceId: WS_A,
      draft: { ...draft, missingFields: draft.missingFields as string[], conversationId, customerId },
    });
    expect(aggregateVerdict(rules)).toBe("REQUIRE_INPUT");
  });

  it("DENY for inactive product", async () => {
    await readyDraft();
    await db.product.update({ where: { id: productId }, data: { isActive: false } });
    const draft = await draftRow();
    const rules = await evaluateOrderRules(db as Db, {
      workspaceId: WS_A, draft: { ...draft, missingFields: [] as string[], conversationId, customerId },
    });
    expect(aggregateVerdict(rules)).toBe("DENY");
    expect(rules.find((r) => r.rule === "product_active")?.reason).toBe("PRODUCT_INACTIVE");
  });

  it("DENY for max quantity", async () => {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId, quantity: 5000, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const d = await draftRow();
    const rules = await evaluateOrderRules(db as Db, {
      workspaceId: WS_A, draft: { ...d, missingFields: [] as string[], conversationId, customerId },
    });
    expect(aggregateVerdict(rules)).toBe("DENY");
  });

  it("REQUIRE_HUMAN for likely duplicate", async () => {
    await readyDraft();
    const first = await draftRow();
    await createOrderFromDraft(db as Db, AGENT, { draftId: first.id });
    // re-activate the draft and refill it (simulating a repeat request)
    await db.orderDraft.update({ where: { conversationId }, data: { state: "COLLECTING", orderId: null } });
    await readyDraft();
    const d = await draftRow();
    const rules = await evaluateOrderRules(db as Db, {
      workspaceId: WS_A, draft: { ...d, missingFields: [] as string[], conversationId, customerId },
    });
    expect(aggregateVerdict(rules)).toBe("REQUIRE_HUMAN");
  });
});

describe("Phase 5 — order creation & idempotency", () => {
  it("creates order with DB price snapshot and idempotency", async () => {
    await readyDraft();
    const draft = await draftRow();
    const result = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    expect(result.created).toBe(true);
    expect(result.total).toBe(450000); // 150000 × 3, no delivery rules → fee 0
    expect(result.currency).toBe("SYP");
    const again = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    expect(again.created).toBe(false);
    expect(again.orderId).toBe(result.orderId);
    expect(db._stores.order).toHaveLength(1);
    const items = db._stores.orderItem as any[];
    expect(items).toHaveLength(1);
    expect(items[0].productNameSnapshot).toBe("ماء الكمأة");
    expect(Number(items[0].unitPrice)).toBe(150000);
  });

  it("price change after order does not change the order snapshot", async () => {
    await readyDraft();
    const draft = await draftRow();
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    await db.product.update({ where: { id: productId }, data: { price: 999999 } });
    const order = await getOwnedOrder(db as Db, WS_A, created.orderId);
    expect(Number(order.items[0].unitPrice)).toBe(150000);
    expect(Number(order.total)).toBe(450000);
  });

  it("AI cannot inject a price — pricing comes from Product DB", async () => {
    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "ماء الكمأة", quantity: 3, phone: "0930000000", address: "دويلعة", province: "دمشق" },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي 3 من ماء الكمأة",
    });
    expect(result.action).toBe("REQUEST_CONFIRMATION");
    const confirmed = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: {}, missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "نعم أكد",
    });
    expect(confirmed.action).toBe("ORDER_CONFIRMED");
    expect(confirmed.total).toBe(450000); // DB price × qty — never 1, never 3
  });

  it("cross-workspace order access fails", async () => {
    await readyDraft();
    const draft = await draftRow();
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    await expect(getOwnedOrder(db as Db, WS_B, created.orderId)).rejects.toBeInstanceOf(AppError);
    await expect(
      transitionOrder(db as Db, { userId: "x", workspaceId: WS_B }, created.orderId, "PROCESSING")
    ).rejects.toBeInstanceOf(AppError);
  });

  it("state machine blocks illegal transitions via service", async () => {
    await readyDraft();
    const draft = await draftRow();
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    await expect(transitionOrder(db as Db, AGENT, created.orderId, "DELIVERED")).rejects.toBeInstanceOf(AppError);
    const updated = await transitionOrder(db as Db, AGENT, created.orderId, "PROCESSING");
    expect(updated.status).toBe("PROCESSING");
  });

  it("duplicate detection: same conversation order → LIKELY", async () => {
    await readyDraft();
    const draft = await draftRow();
    await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    const level = await detectDuplicate(db as Db, {
      workspaceId: WS_A, customerId, conversationId, productId, quantity: 3,
    });
    expect(level).toBe("LIKELY");
  });

  it("customer merge does not overwrite phone with low confidence", async () => {
    const merge = await mergeCustomerData(db as Db, AGENT, customerId, {
      phone: { value: "0944555666", confidence: 0.5 },
    });
    expect(merge.needsConfirmation).toContain("phone_mismatch");
    const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.phone).toBe("0930000000");
  });

  it("customer merge accepts explicit high-confidence phone change", async () => {
    await mergeCustomerData(db as Db, AGENT, customerId, {
      phone: { value: "0944555666", confidence: 0.97 },
    });
    const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.phone).toBe("0944555666");
  });

  it("order draft is persisted, not in-memory", async () => {
    await readyDraft();
    const draft = await draftRow();
    expect(draft.productId).toBe(productId);
    expect(draft.quantity).toBe(3);
    expect(draft.phone).toBe("0930000000");
    expect(draft.state).toBe("READY");
  });

  it("ambiguity → clarification, never a guess", async () => {
    await createProduct(db as Db, AGENT, { name: "ماء الكمأة الأصلي", sku: "TW-ORIG", price: 200000 });
    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.9, language: "ar",
        entities: { product: "ماء الكمأة", quantity: 1 },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي ماء الكمأة",
    });
    expect(result.action).toBe("ASK_MISSING_FIELD");
    expect(result.summaryText).toContain("أي واحد تقصد");
  });
});

describe("Phase 5 — full AI → Order pipeline", () => {
  it("customer order flow through the orchestrator ends with a DB order", async () => {
    const inbound = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "fb-1",
      externalConversationId: "fb-conv-1", externalMessageId: "m1", externalEventId: "e1",
      provider: "mock", type: "TEXT",
      text: "بدي 3 من ماء الكمأة، رقمي 0930000000، عنواني دمشق دويلعة",
    });
    const result = await processAIMessage(db as Db, {
      workspaceId: WS_A, conversationId, messageId: inbound.messageId,
    }, { vectorStore: emptyStore() });
    expect(["RESPONDED", "CLARIFIED"]).toContain(result.status);
    const draft = await draftRow();
    expect(draft.productId).toBe(productId);
    expect(draft.state).toBe("READY");

    const confirmMsg = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", externalUserId: "fb-1",
      externalConversationId: "fb-conv-1", externalMessageId: "m2", externalEventId: "e2",
      provider: "mock", type: "TEXT", text: "نعم أكد",
    });
    await processAIMessage(db as Db, {
      workspaceId: WS_A, conversationId, messageId: confirmMsg.messageId,
    }, { vectorStore: emptyStore() });
    const orders = db._stores.order as any[];
    expect(orders).toHaveLength(1);
    expect(Number(orders[0].total)).toBe(450000);
  });
});

describe("Phase 5 — audit", () => {
  it("audits draft updates, order creation and price calculation", async () => {
    await readyDraft();
    const draft = await draftRow();
    await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    const actions = (db._stores.auditLog as any[]).map((a) => a.action);
    expect(actions).toContain("order_draft.updated");
    expect(actions).toContain("order.created");
    expect(actions).toContain("price.calculated");
  });
});
