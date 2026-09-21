import { randomId } from "@/core/crypto";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { assertOrderTransition, canTransitionOrder } from "./state-machine";
import { aggregateVerdict, evaluateOrderRules, type RuleResult } from "./rules";
import { calculatePricing } from "./pricing";
import type { OrderDraft, Prisma } from "@prisma/client";

export interface CreateOrderFromDraftResult {
  orderId: string;
  orderNumber: string;
  status: string;
  total: number;
  currency: string;
  created: boolean;
  rules: RuleResult[];
}

/**
 * OrderService â€” the ONLY component allowed to create/update orders.
 * AI never calls this directly and never reaches Prisma mutations: it only
 * proposes an intent, which OrderIntelligence routes through the rules here.
 *
 * Idempotent: `idempotencyKey` has a unique constraint â€” the same action
 * arriving twice (webhook retry, duplicated AI action) creates ONE order.
 */
export async function createOrderFromDraft(
  db: Db,
  ctx: ActorContext,
  params: { draftId: string; source?: string; requireConfirmation?: boolean }
): Promise<CreateOrderFromDraftResult> {
  const draft = (await db.orderDraft.findUnique({ where: { id: params.draftId } })) as OrderDraft | null;
  if (!draft || draft.workspaceId !== ctx.workspaceId) throw new NotFoundError("Order draft");

  // Idempotency: already converted?
  if (draft.orderId) {
    const existing = await db.order.findUnique({ where: { id: draft.orderId } });
    if (existing) {
      return {
        orderId: existing.id,
        orderNumber: existing.orderNumber,
        status: existing.status,
        total: Number(existing.total),
        currency: existing.currency,
        created: false,
        rules: [],
      };
    }
  }

  // Rules engine decides â€” no exceptions, no bypasses.
  const rules = await evaluateOrderRules(db, {
    workspaceId: ctx.workspaceId,
    draft: {
      productId: draft.productId,
      quantity: draft.quantity,
      phone: draft.phone,
      rawAddress: draft.rawAddress,
      province: draft.province,
      missingFields: draft.missingFields as string[],
      customerId: draft.customerId,
      conversationId: draft.conversationId,
    },
  });
  const verdict = aggregateVerdict(rules);
  if (verdict === "DENY") {
    throw new AppError(
      `Order rejected by rules: ${rules.filter((r) => r.verdict === "DENY").map((r) => r.reason).join(", ")}`,
      422,
      "ORDER_RULES_DENIED"
    );
  }
  if (verdict === "REQUIRE_INPUT") {
    throw new AppError("Missing required fields", 422, "ORDER_MISSING_FIELDS");
  }
  if (verdict === "REQUIRE_HUMAN") {
    throw new AppError("Order requires human review", 422, "ORDER_REQUIRES_HUMAN");
  }

  const product = await db.product.findUnique({ where: { id: draft.productId! } });
  if (!product || product.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");

  // Pricing from Product DB â€” AI price input does not exist in this function.
  const breakdown = await calculatePricing(db, {
    workspaceId: ctx.workspaceId,
    product: { price: product.price, currency: product.currency },
    quantity: draft.quantity!,
    province: draft.province,
  });
  if (!breakdown.deliveryAvailable) {
    throw new AppError("Delivery not available for this province", 422, "DELIVERY_UNAVAILABLE");
  }

  const idempotencyKey = draft.idempotencyKey ?? `draft:${draft.id}`;
  const existingByIdem = await db.order.findUnique({ where: { idempotencyKey } });
  if (existingByIdem) {
    return {
      orderId: existingByIdem.id,
      orderNumber: existingByIdem.orderNumber,
      status: existingByIdem.status,
      total: Number(existingByIdem.total),
      currency: existingByIdem.currency,
      created: false,
      rules,
    };
  }

  const customer = await db.customer.findUnique({ where: { id: draft.customerId } });
  if (!customer) throw new NotFoundError("Customer");

  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${randomId(3).toUpperCase()}`;
  const status = "CONFIRMED";
  const order = await db.order.create({
    data: {
      workspaceId: ctx.workspaceId,
      orderNumber,
      customerId: draft.customerId,
      conversationId: draft.conversationId,
      draftId: draft.id,
      status,
      confirmationStatus: "CONFIRMED_BY_CUSTOMER",
      deliveryAddress: draft.rawAddress,
      province: draft.province,
      notes: draft.notes ?? null,
      subtotal: breakdown.subtotal,
      discount: breakdown.discount,
      deliveryFee: breakdown.deliveryFee,
      total: breakdown.total,
      currency: breakdown.currency,
      source: params.source ?? "AI",
      idempotencyKey,
      items: {
        create: {
          productId: product.id,
          variantId: draft.variantId,
          productNameSnapshot: product.name,
          skuSnapshot: product.sku,
          unitPrice: breakdown.unitPrice,
          quantity: draft.quantity!,
          subtotal: breakdown.subtotal,
        },
      },
    } as Prisma.OrderUncheckedCreateInput,
  });

  await db.orderDraft.update({
    where: { id: draft.id },
    data: { state: "CONVERTED", orderId: order.id, idempotencyKey },
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "order.created",
    entityType: "Order",
    entityId: order.id,
    metadata: { orderNumber, total: breakdown.total, currency: breakdown.currency, source: params.source ?? "AI" },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    action: "price.calculated",
    entityType: "Order",
    entityId: order.id,
    metadata: { ...breakdown },
  });
  await eventBus.publish(
    makeEvent("OrderCreated", ctx.workspaceId, { orderId: order.id, total: breakdown.total, customerId: draft.customerId, conversationId: draft.conversationId })
  );
  await eventBus.publish(
    makeEvent("CustomerUpdated", ctx.workspaceId, { customerId: draft.customerId, type: "order.created" })
  );
  if (order.status === "CONFIRMED") {
    await eventBus.publish(
      makeEvent("OrderConfirmed", ctx.workspaceId, { orderId: order.id, customerId: draft.customerId, conversationId: draft.conversationId })
    );
  }

  return {
    orderId: order.id,
    orderNumber,
    status: order.status,
    total: breakdown.total,
    currency: breakdown.currency,
    created: true,
    rules,
  };
}

/** Validated status transition â€” the only way an order status changes. */
export async function transitionOrder(db: Db, ctx: ActorContext, orderId: string, to: OrderStatusForTransition) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order || order.workspaceId !== ctx.workspaceId) throw new NotFoundError("Order");
  assertOrderTransition(order.status, to);
  const updated = await db.order.update({
    where: { id: orderId },
    data: {
      status: to,
      ...(to === "CANCELLED" ? { confirmationStatus: "DECLINED" } : {}),
    },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: to === "CANCELLED" ? "order.cancelled" : "order.state_changed",
    entityType: "Order",
    entityId: orderId,
    metadata: { from: order.status, to },
  });
  await eventBus.publish(
    makeEvent("ConversationUpdated", ctx.workspaceId, {
      type: to === "CANCELLED" ? "OrderCancelled" : "OrderStateChanged",
      orderId,
      from: order.status,
      to,
    })
  );
  return updated;
}

export type OrderStatusForTransition = Parameters<typeof canTransitionOrder>[1];

export async function getOwnedOrder(db: Db, workspaceId: string, orderId: string) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: true, customer: { select: { id: true, name: true, phone: true } } },
  });
  if (!order || order.workspaceId !== workspaceId) throw new NotFoundError("Order");
  return order;
}

export async function listOrders(
  db: Db,
  params: {
    workspaceId: string;
    status?: string;
    confirmationStatus?: string;
    customerId?: string;
    productId?: string;
    cursor?: string;
    limit?: number;
  }
) {
  const limit = Math.min(params.limit ?? 25, 100);
  const where: Prisma.OrderWhereInput = { workspaceId: params.workspaceId };
  if (params.status) where.status = params.status as Prisma.EnumOrderStatusFilter["equals"];
  if (params.confirmationStatus) {
    where.confirmationStatus = params.confirmationStatus as Prisma.EnumConfirmationStatusFilter["equals"];
  }
  if (params.customerId) where.customerId = params.customerId;
  if (params.productId) where.items = { some: { productId: params.productId } };

  const orders = await db.order.findMany({
    where,
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      items: { select: { productNameSnapshot: true, quantity: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = orders.length > limit;
  const items = hasMore ? orders.slice(0, limit) : orders;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

// â”€â”€ Customer data merging (confidence-gated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface CustomerMergeInput {
  customerName?: { value: string; confidence: number } | null;
  phone?: { value: string; confidence: number } | null;
  address?: { value: string; confidence: number } | null;
  province?: { value: string; confidence: number } | null;
}

/**
 * Updates the Customer from extracted data WITHOUT letting low-confidence
 * values overwrite good ones. A different phone at low confidence is stored
 * as a note for confirmation â€” never auto-replaces the existing phone.
 */
export async function mergeCustomerData(
  db: Db,
  ctx: ActorContext,
  customerId: string,
  input: CustomerMergeInput
) {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer || customer.workspaceId !== ctx.workspaceId) throw new NotFoundError("Customer");

  const data: Prisma.CustomerUncheckedUpdateInput = {};
  const needsConfirmation: string[] = [];
  const CONFIDENT = 0.8;

  if (input.customerName?.value && !customer.name && input.customerName.confidence >= CONFIDENT) {
    data.name = input.customerName.value;
  }
  if (input.phone?.value) {
    if (!customer.phone && input.phone.confidence >= CONFIDENT) {
      data.phone = input.phone.value;
    } else if (customer.phone && input.phone.value !== customer.phone) {
      if (input.phone.confidence >= 0.95) {
        // Explicit "this is my new number" style update (high confidence).
        data.phone = input.phone.value;
        needsConfirmation.push("phone_replaced");
      } else {
        needsConfirmation.push("phone_mismatch");
      }
    }
  }
  if (input.address?.value && input.address.confidence >= CONFIDENT) data.address = input.address.value;
  if (input.province?.value && input.province.confidence >= CONFIDENT) data.province = input.province.value;

  if (Object.keys(data).length > 0) {
    await db.customer.update({ where: { id: customerId }, data });
    await recordAudit(db, {
      workspaceId: ctx.workspaceId,
      action: "customer.merged_from_order",
      entityType: "Customer",
      entityId: customerId,
      metadata: { fields: Object.keys(data) },
    });
  }
  return { updated: Object.keys(data), needsConfirmation };
}

