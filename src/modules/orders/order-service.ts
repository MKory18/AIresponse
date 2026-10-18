import { randomId } from "@/core/crypto";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { requireWorkspaceOwner } from "@/modules/rbac/owner-guard";
import type { ActorContext, Db } from "@/modules/customers/service";
import { assertOrderTransition, canTransitionOrder } from "./state-machine";
import { aggregateVerdict, evaluateOrderRules, type RuleResult } from "./rules";
import { calculatePricing } from "./pricing";
import type { Order, OrderDraft, OrderItem, OrderStatus, Prisma } from "@prisma/client";

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

  // P2 OMS blacklist enforcement (single choke point): a blacklisted
  // customer can still chat and hold a draft, but NO order is ever created
  // for them — the OMS blacklist decision always wins over local staleness.
  if ((customer as { isBlacklisted?: boolean }).isBlacklisted === true) {
    await recordAudit(db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: "order.blacklisted_blocked",
      entityType: "OrderDraft",
      entityId: draft.id,
      metadata: { customerId: customer.id },
    });
    throw new AppError("Customer is blacklisted — order creation refused", 422, "ORDER_CUSTOMER_BLACKLISTED");
  }

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

  // P8 — مصدر الإعلان: الطلب يرث مصدر العميل الموثوق (لمسة أولى) إن وُجد،
  // ولا يُخترع أبدًا. كما تُسجَّل نتيجة عروض البيع: قبول العرض (كمية الطلب
  // ≥ كمية العرض المعروض لنفس SKU) وإضافة المنتج المكمل (طلِب المنتج الذي
  // قُدِّم سابقًا كمكمل في هذه المحادثة). الفشل لا يكسر إنشاء الطلب أبدًا.
  try {
    const { recordSalesEvent } = await import("@/modules/sales/metrics");
    if ((customer as { adSource?: string | null }).adSource) {
      await db.order.update({ where: { id: order.id }, data: { adSource: (customer as { adSource?: string | null }).adSource! } as never });
    }
    const shownRows = await (db as unknown as {
      salesEvent: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
    }).salesEvent.findMany({
      where: { workspaceId: ctx.workspaceId, conversationId: draft.conversationId, sku: product.sku },
    }).catch(() => [] as Array<Record<string, unknown>>);
    if (shownRows.some((r) => r.type === "OFFER_SHOWN")) {
      const offerQty = shownRows
        .filter((r) => r.type === "OFFER_SHOWN")
        .map((r) => Number((r.payload as { quantity?: number } | null)?.quantity ?? 0))
        .reduce((a: number, b: number) => Math.max(a, b), 0);
      if (!offerQty || draft.quantity! >= offerQty) {
        await recordSalesEvent(db, {
          workspaceId: ctx.workspaceId,
          type: "OFFER_ACCEPTED",
          conversationId: draft.conversationId,
          customerId: draft.customerId,
          orderId: order.id,
          productId: product.id,
          sku: product.sku,
          value: breakdown.total,
        });
      }
    }
    if (shownRows.some((r) => r.type === "CROSS_SELL_SHOWN")) {
      await recordSalesEvent(db, {
        workspaceId: ctx.workspaceId,
        type: "CROSS_SELL_ADDED",
        conversationId: draft.conversationId,
        customerId: draft.customerId,
        orderId: order.id,
        productId: product.id,
        sku: product.sku,
        value: breakdown.total,
      });
    }
  } catch {
    // sales hooks are best-effort — never break order creation
  }

  // P12 — لقطة الإسناد على الطلب (رقم الإعلان · رمز الكليبر · القناة) من
  // الحلقة الفعّالة لحظة الإنشاء، ثم ترحيل تلقائي للـ OMS إذا مفعّل بالـ API.
  // الاتنين best-effort: فشلهم ما بيكسر طلب انحفظ (الترحيل اليدوي متاح دايمًا).
  try {
    const { snapshotOrderAttribution } = await import("@/modules/integrations/attribution");
    const conv = draft.conversationId
      ? ((await db.conversation.findUnique({ where: { id: draft.conversationId }, select: { channelId: true } })) as { channelId?: string } | null)
      : null;
    const channel = conv?.channelId
      ? ((await db.channel.findUnique({ where: { id: conv.channelId }, select: { type: true } })) as { type?: string } | null)
      : null;
    await snapshotOrderAttribution(db, {
      id: order.id,
      workspaceId: ctx.workspaceId,
      conversationId: draft.conversationId,
      createdAt: (order as { createdAt?: Date }).createdAt ?? new Date(),
      channelType: channel?.type ?? null,
    });
  } catch {
    // الإسناد معلومة إضافية — غيابها ما بيوقف الطلب
  }

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

  // مستودع الطلبات — إشعار تلجرام (best-effort، ما يكسر إنشاء الطلب).
  try {
    let token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ORDER_CHAT_ID;
    if (!token) {
      // Fallback: use the workspace's connected Telegram channel token.
      try {
        const account = await (db as any).channelAccount?.findFirst?.({
          where: { channel: { workspaceId: ctx.workspaceId, type: "TELEGRAM", status: "CONNECTED" } },
          select: { encryptedCredentials: true },
        });
        if (account?.encryptedCredentials) {
          const { decryptSecret } = await import("@/core/crypto");
          token = decryptSecret(account.encryptedCredentials);
        }
      } catch {
        token = undefined;
      }
    }
    if (token && chatId) {
      const { getTelegramClient } = await import("@/modules/channels/telegram/client");
      const client = getTelegramClient();
      const text =
        `📦 طلب جديد\n` +
        `رقم: ${orderNumber}\n` +
        `العميل: ${customer?.name ?? customer?.phone ?? "-"}\n` +
        `المنتج: ${product.name} × ${draft.quantity}\n` +
        `المجموع: ${breakdown.total} ${breakdown.currency}\n` +
        `الحالة: ${status}`;
      await client.sendMessage(token, chatId, { text });
    }
  } catch {
    // الإشعار best-effort — غيابه ما يوقف الطلب
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

/**
 * EDIT A PLACED ORDER FROM CHAT — the customer asks to change the latest
 * order of the conversation (quantity/address/notes). Prices are NEVER
 * accepted from the AI: the locked unit price is kept and totals are
 * recomputed deterministically through calculatePricing. A terminal order
 * (delivered/returned/failed/cancelled/out-for-delivery) refuses edits.
 */
export type ChatOrderEdit =
  | { ok: true; order: Order; changed: string[] }
  | { ok: false; reason: "NO_ORDER" }
  | { ok: false; reason: "NOT_EDITABLE"; orderNumber: string; statusLabel: string };

export async function updateOrderFromChat(
  db: Db,
  ctx: ActorContext,
  params: {
    conversationId: string;
    quantity?: number | null;
    rawAddress?: string | null;
    province?: string | null;
    notes?: string | null;
    phone?: string | null;
  }
): Promise<ChatOrderEdit> {
  const latest = (await db.order.findMany({
    where: { workspaceId: ctx.workspaceId, conversationId: params.conversationId },
    orderBy: { createdAt: "desc" },
    take: 1,
  })) as Order[];
  const order = latest[0];
  if (!order) return { ok: false, reason: "NO_ORDER" };

  // Editability = the state machine can still cancel it: NEW,
  // CONFIRMATION_PENDING, CONFIRMED, PROCESSING. Everything else is final.
  if (!canTransitionOrder(order.status, "CANCELLED")) {
    return { ok: false, reason: "NOT_EDITABLE", orderNumber: order.orderNumber, statusLabel: order.status };
  }

  const changed: string[] = [];
  const data: Prisma.OrderUncheckedUpdateInput = {};
  const newProvince = params.province ?? order.province;
  if (params.province && params.province !== order.province) {
    data.province = params.province;
    changed.push("province");
  }
  if (params.rawAddress && params.rawAddress !== order.deliveryAddress) {
    data.deliveryAddress = params.rawAddress;
    changed.push("address");
  }
  if (params.notes && params.notes !== order.notes) {
    data.notes = params.notes;
    changed.push("notes");
  }

  if (params.quantity && params.quantity > 0) {
    const items = (await db.orderItem.findMany({ where: { orderId: order.id } })) as OrderItem[];
    const item = items[0];
    if (item) {
      // Price snapshot stays locked (item.unitPrice — never a live Product
      // price); totals are recomputed through the same pricing engine as
      // creation so offers and delivery stay consistent.
      const breakdown = await calculatePricing(db, {
        workspaceId: ctx.workspaceId,
        product: { price: Number(item.unitPrice), currency: order.currency },
        quantity: params.quantity,
        province: newProvince,
      });
      if (!breakdown.deliveryAvailable) {
        throw new AppError("Delivery not available for this province", 422, "DELIVERY_UNAVAILABLE");
      }
      await db.orderItem.updateMany({
        where: { orderId: order.id },
        data: { quantity: params.quantity, subtotal: breakdown.subtotal },
      });
      data.subtotal = breakdown.subtotal;
      data.discount = breakdown.discount;
      data.deliveryFee = breakdown.deliveryFee;
      data.total = breakdown.total;
      data.currency = breakdown.currency;
      changed.push("quantity");
    }
  } else if (data.province) {
    // Province moved without a quantity change — delivery fee must follow.
    const items = (await db.orderItem.findMany({ where: { orderId: order.id } })) as OrderItem[];
    const item = items[0];
    if (item) {
      const breakdown = await calculatePricing(db, {
        workspaceId: ctx.workspaceId,
        product: { price: Number(item.unitPrice), currency: order.currency },
        quantity: item.quantity,
        province: newProvince,
      });
      if (!breakdown.deliveryAvailable) {
        throw new AppError("Delivery not available for this province", 422, "DELIVERY_UNAVAILABLE");
      }
      data.deliveryFee = breakdown.deliveryFee;
      data.total = Number(item.subtotal) + breakdown.deliveryFee;
    }
  }

  const updated = Object.keys(data).length
    ? ((await db.order.update({ where: { id: order.id }, data })) as Order)
    : order;

  if (params.phone) {
    // Contact changes go through the confidence-gated customer merge.
    await mergeCustomerData(db, ctx, order.customerId, {
      phone: { value: params.phone, confidence: 0.9 },
    });
  }

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "order.updated_from_chat",
    entityType: "Order",
    entityId: order.id,
    ip: ctx.ip,
    metadata: { fields: changed, orderNumber: order.orderNumber },
  });
  await eventBus.publish(
    makeEvent("OrderUpdated", ctx.workspaceId, { orderId: order.id, conversationId: params.conversationId, fields: changed })
  );
  return { ok: true, order: updated, changed };
}

/** Cancels the latest still-cancellable order of the conversation (chat "ألغَ"). */
export async function cancelLatestOrderFromConversation(
  db: Db,
  ctx: ActorContext,
  conversationId: string
): Promise<{ orderId: string; orderNumber: string } | null> {
  const candidates = (await db.order.findMany({
    where: { workspaceId: ctx.workspaceId, conversationId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, status: true, orderNumber: true },
  })) as Array<{ id: string; status: OrderStatus; orderNumber: string }>;
  const target = candidates.find((o) => canTransitionOrder(o.status, "CANCELLED"));
  if (!target) return null;
  await transitionOrder(db, ctx, target.id, "CANCELLED");
  return { orderId: target.id, orderNumber: target.orderNumber };
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
  const page = hasMore ? orders.slice(0, limit) : orders;
  // P12: معرّفات الإسناد المشفّرة (رمز النقرة · PSID) ما بتطلع بأي قائمة.
  const items = page.map((o) => withoutClickSecrets(o));
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/**
 * P12: طلب للمتصفح بلا معرّفات الإسناد المشفّرة (رمز النقرة · PSID) — كل
 * رد API بيرجّع صف طلب لازم يمر من هون (القوائم · التفاصيل · التعديل).
 */
export function withoutClickSecrets<T extends object>(order: T): Omit<T, "ctwaClidEnc" | "psidEnc"> {
  const { ctwaClidEnc: _c, psidEnc: _p, ...rest } = order as T & { ctwaClidEnc?: unknown; psidEnc?: unknown };
  void _c;
  void _p;
  return rest as Omit<T, "ctwaClidEnc" | "psidEnc">;
}

/**
 * حذف طلب — صلاحية المالك (OWNER) فقط، حذف نهائي بكل بنوده.
 *
 * الحماية ثلاثية: بوابة `orders.write` بالمسار، ثم هذا الحارس الذي يقرأ رتبة
 * الفاعل طازجة من القاعدة (ADMIN بيملك orders.write ومع هيك محجوب)، ثم حصر
 * الصف بمساحة الفاعل قبل أي حذف (طلب مساحة تانية = «غير موجود» بلا تسريب
 * وجوده). سجل التدقيق يحفظ لقطة الطلب (الرقم · الحالة · المجموع · عدد
 * البنود) فيبقى الأثر بعد زوال الصف.
 */
export async function deleteOrder(db: Db, ctx: ActorContext, orderId: string) {
  const order = (await db.order.findUnique({
    where: { id: orderId },
    include: { items: { select: { id: true } } },
  })) as
    | { id: string; workspaceId: string; orderNumber: string; status: string; total: unknown; currency: string; items: { id: string }[] }
    | null;
  if (!order || order.workspaceId !== ctx.workspaceId) throw new NotFoundError("Order");

  await requireWorkspaceOwner(db, ctx, {
    code: "OWNER_ONLY_ORDERS",
    message: "حذف الطلبات متاح للمالك فقط",
  });

  // الترتيب صريح (بنود ثم الطلب): مضمون على القاعدة الحقيقية بالقيد Cascade
  // وعلى البديل بالذاكرة بالحذف المباشر — نفس النتيجة بالحالتين.
  await db.orderItem.deleteMany({ where: { orderId: order.id } });
  await db.order.delete({ where: { id: order.id } });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "order.deleted",
    entityType: "Order",
    entityId: order.id,
    metadata: {
      orderNumber: order.orderNumber,
      status: order.status,
      total: String(order.total ?? ""),
      currency: order.currency ?? null,
      itemCount: order.items.length,
    },
  });

  return { deleted: true, id: order.id, orderNumber: order.orderNumber };
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

