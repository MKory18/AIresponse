import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { createOrderFromDraft, getOwnedOrder } from "@/modules/orders/order-service";
import { handleOrderIntent } from "@/modules/orders/intelligence";
import { createProduct } from "@/modules/products/service";

const WS_A = "ws-a";
const AGENT = { userId: "agent-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let productIdA: string;
let productIdB: string;
let conversationId: string;
let customerId: string;

async function seedWorld() {
  db = createFakeDb();
  const productA = await createProduct(db as Db, AGENT, {
    name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP",
  });
  productIdA = productA.id;
  const productB = await createProduct(db as Db, AGENT, {
    name: "زيت الزيتون", sku: "OL-100", price: 90000, currency: "SYP",
  });
  productIdB = productB.id;
  const customer = await db.customer.create({
    data: { workspaceId: WS_A, name: "محمد", phone: "0930000000", status: "INTERESTED" },
  } as never);
  customerId = customer.id;
  const conv = await db.conversation.create({
    data: { workspaceId: WS_A, customerId, channelId: "ch-1", channelConversationId: "fb-conv-1" },
  } as never);
  conversationId = conv.id;
}

async function orderRows() {
  return db._stores.order as any[];
}

beforeEach(seedWorld);

describe("multi-order flow — a conversation holds many orders", () => {
  it("a new order request after a confirmed order starts a SECOND order", async () => {
    // Order #1 — created and confirmed.
    const first = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "ماء الكمأة", quantity: 3, phone: "0930000000", address: "دويلعة", province: "دمشق" },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي 3 من ماء الكمأة",
    });
    expect(first.action).toBe("REQUEST_CONFIRMATION");
    const confirmed = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: {}, missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "نعم أكد",
    });
    expect(confirmed.action).toBe("ORDER_CONFIRMED");

    // Order #2 — same conversation, different product. The closed draft must
    // NOT dead-end with DRAFT_CLOSED: it recycles into a fresh cart.
    const second = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "زيت الزيتون", quantity: 2 },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي زيت زيتون كمان 2",
    });
    expect(second.action).toBe("REQUEST_CONFIRMATION");
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as {
      state: string; productId: string | null; orderId: string | null; quantity: number | null;
    };
    expect(draft.state).toBe("READY");
    expect(draft.productId).toBe(productIdB);
    expect(draft.quantity).toBe(2);
    expect(draft.orderId).toBeNull();

    const confirmed2 = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: {}, missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "نعم أكد",
    });
    expect(confirmed2.action).toBe("ORDER_CONFIRMED");
    expect(confirmed2.orderId).not.toBe(confirmed.orderId);

    const orders = await orderRows();
    expect(orders).toHaveLength(2);
  });

  it("recycled draft keeps the customer contact from the previous order", async () => {
    await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "ماء الكمأة", quantity: 3, customer_name: "محمد", phone: "0930000000", address: "دويلعة", province: "دمشق" },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي 3 من ماء الكمأة",
    });
    await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: {}, missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "نعم أكد",
    });
    const second = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "زيت الزيتون", quantity: 1 },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي زيت زيتون",
    });
    expect(second.action).toBe("REQUEST_CONFIRMATION");
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as {
      phone: string | null; rawAddress: string | null; province: string | null; customerName: string | null;
    };
    expect(draft.phone).toBe("0930000000");
    expect(draft.rawAddress).toBe("دويلعة");
    expect(draft.province).toBe("دمشق");
    expect(draft.customerName).toBe("محمد");
  });

  it("duplicate rule no longer blocks a different-product second order", async () => {
    // Same conversation + same product stays LIKELY (accidental double order);
    // a different product in the same conversation is a legitimate new order.
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId: productIdA, quantity: 3, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as { id: string };
    await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });

    const second = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "زيت الزيتون", quantity: 2 },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي زيت زيتون 2",
    });
    expect(second.action).toBe("REQUEST_CONFIRMATION");
  });
});

describe("multi-order flow — editing a placed order from chat", () => {
  it("quantity edit updates the placed order and reprices it", async () => {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId: productIdA, quantity: 3, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as { id: string };
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });

    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_UPDATE", confidence: 0.9, language: "ar",
        entities: { quantity: 5 }, missingFields: [], memories: [], requestedAction: "ANSWER",
      },
      customerText: "زوّد الكمية خمس حبات",
    });
    expect(result.action).toBe("ORDER_UPDATED");
    expect(result.orderId).toBe(created.orderId);
    expect(result.total).toBe(750000); // locked unit price 150000 × 5, no delivery fee

    const order = await getOwnedOrder(db as Db, WS_A, created.orderId);
    expect(Number(order.total)).toBe(750000);
    const items = db._stores.orderItem as any[];
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(5);
    // Only ONE order — an edit never duplicates it.
    expect(await orderRows()).toHaveLength(1);
  });

  it("address edit updates delivery details on the placed order", async () => {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId: productIdA, quantity: 2, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as { id: string };
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });

    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_UPDATE", confidence: 0.9, language: "ar",
        entities: { address: "المزة الشارع الخامس", province: "دمشق" },
        missingFields: [], memories: [], requestedAction: "ANSWER",
      },
      customerText: "غيّر العنوان المزة الشارع الخامس",
    });
    expect(result.action).toBe("ORDER_UPDATED");
    const order = await getOwnedOrder(db as Db, WS_A, created.orderId);
    expect(order.deliveryAddress).toBe("المزة الشارع الخامس");
    expect(order.province).toBe("دمشق");
  });

  it("delivered/terminal orders refuse edits", async () => {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId: productIdA, quantity: 3, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as { id: string };
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });
    // NEW → PROCESSING → OUT_FOR_DELIVERY (legal forward path).
    const { transitionOrder } = await import("@/modules/orders/order-service");
    await transitionOrder(db as Db, AGENT, created.orderId, "PROCESSING");
    await transitionOrder(db as Db, AGENT, created.orderId, "OUT_FOR_DELIVERY");

    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_UPDATE", confidence: 0.9, language: "ar",
        entities: { quantity: 7 }, missingFields: [], memories: [], requestedAction: "ANSWER",
      },
      customerText: "زوّد الكمية 7",
    });
    expect(result.action).toBe("NONE");
    const order = await getOwnedOrder(db as Db, WS_A, created.orderId);
    const items = db._stores.orderItem as any[];
    expect(items[0].quantity).toBe(3); // untouched
    expect(order).toBeTruthy();
  });

  it("cancelling after a placed order cancels that ORDER (not just the draft)", async () => {
    await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: { productId: productIdA, quantity: 3, phone: "0930000000", rawAddress: "دويلعة", province: "دمشق" },
      source: "TEST",
    });
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId } }) as never as { id: string };
    const created = await createOrderFromDraft(db as Db, AGENT, { draftId: draft.id });

    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CANCEL", confidence: 0.95, language: "ar",
        entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER",
      },
      customerText: "ألغى الطلب",
    });
    expect(result.action).toBe("ORDER_CANCELLED");
    const order = await getOwnedOrder(db as Db, WS_A, created.orderId);
    expect(order.status).toBe("CANCELLED");

    // After a cancelled order the conversation can still place a new one.
    const second = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId, customerId,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "زيت الزيتون", quantity: 1 },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي زيت زيتون بدال ياه",
    });
    expect(second.action).toBe("REQUEST_CONFIRMATION");
  });
});
