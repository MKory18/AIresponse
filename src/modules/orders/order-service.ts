import { randomId } from "@/core/crypto";
import { AppError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import { publishRealtime } from "@/modules/realtime/events";
import { requireWorkspaceOwner } from "@/modules/rbac/owner-guard";
import type { ActorContext, Db } from "@/modules/customers/service";
import { assertOrderTransition, canTransitionOrder } from "./state-machine";
import { aggregateVerdict, evaluateOrderRules, type RuleResult } from "./rules";
import { calculatePricing, calculateCartPricing } from "./pricing";
import { quoteDelivery } from "./delivery";
import { computeMissingFields, getRequiredOrderFields, parseDraftItems } from "./draft-service";
import { telegramNotifiedOrderIds } from "./telegram-status";
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

  // A closed draft with no order (cancelled) can never create an order.
  if (draft.state === "CANCELLED" || draft.state === "CONVERTED") {
    throw new AppError("Draft is closed", 422, "DRAFT_CLOSED");
  }

  // P19 — أعِد حساب الناقص بحدود صفحة المحادثة لحظة التأكيد: إعداد الصفحة
  // ممكن يتغيّر بعد ما صارت المسودة READY، والطلب ما بينشأ إذا لسا ناقص.
  const requiredFields = await getRequiredOrderFields(db, ctx.workspaceId, draft.conversationId);
  const missingNow = computeMissingFields(draft, requiredFields);
  if (missingNow.length !== (draft.missingFields as string[]).length) {
    await db.orderDraft.update({
      where: { id: draft.id },
      data: { missingFields: missingNow },
    });
  }

  // P22 — سلة: كل عنصر يُتحقق ويُسعّر من قاعدة البيانات (بلا أسعار من الموديل).
  const draftItems = parseDraftItems(draft);
  const itemIds = [...new Set(draftItems.map((i) => i.productId).filter((v): v is string => Boolean(v)))];
  const products = itemIds.length
    ? await db.product.findMany({
        where: { id: { in: itemIds }, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          name: true,
          sku: true,
          price: true,
          currency: true,
          isActive: true,
          isArchived: true,
          stockStatus: true,
          workspaceId: true,
        },
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  // Rules engine decides — no exceptions, no bypasses.
  const rules = await evaluateOrderRules(db, {
    workspaceId: ctx.workspaceId,
    draft: {
      productId: draft.productId,
      quantity: draft.quantity,
      phone: draft.phone,
      rawAddress: draft.rawAddress,
      province: draft.province,
      missingFields: missingNow,
      customerId: draft.customerId,
      conversationId: draft.conversationId,
      items: draftItems.map((i) => ({ productId: i.productId, quantity: i.quantity })),
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

  if (draftItems.length === 0) throw new AppError("Missing required fields", 422, "ORDER_MISSING_FIELDS");
  const orderLines = draftItems.map((item) => {
    if (!item.productId) throw new AppError("Missing product", 422, "ORDER_MISSING_FIELDS");
    const product = productById.get(item.productId);
    if (!product || product.workspaceId !== ctx.workspaceId) throw new NotFoundError("Product");
    if (!product.isActive || product.isArchived) {
      throw new AppError(`Product inactive: ${product.name}`, 422, "ORDER_RULES_DENIED");
    }
    if (!item.quantity || item.quantity <= 0) {
      throw new AppError("Missing quantity", 422, "ORDER_MISSING_FIELDS");
    }
    return { item, product, quantity: item.quantity };
  });
  if (orderLines.length === 0) throw new AppError("Missing required fields", 422, "ORDER_MISSING_FIELDS");
  if (new Set(orderLines.map((l) => l.product.currency)).size > 1) {
    throw new AppError("Order items use different currencies", 422, "MIXED_CURRENCY");
  }

  // Pricing from Product DB — AI price input does not exist in this function.
  const breakdown = await calculateCartPricing(db, {
    workspaceId: ctx.workspaceId,
    items: orderLines.map((line) => ({
      price: line.product.price,
      quantity: line.quantity,
      currency: line.product.currency,
    })),
    province: draft.province,
  });
  if (!breakdown.deliveryAvailable) {
    throw new AppError("Delivery not available for this province", 422, "DELIVERY_UNAVAILABLE");
  }
  // hooks best-effort (sales events) تستخدم العنصر الأول — لا تغيّر الطلب.
  const primary = orderLines[0];

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

  // Phase 1.1 — order row + draft conversion happen together. When the host
  // provides a real transaction (Prisma) they are atomic; the unique
  // idempotencyKey makes a concurrent confirmation resolve to one order
  // instead of a 500.
  const writeOrder = async (tx: Db): Promise<Order> => {
    const created = (await tx.order.create({
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
          create: orderLines.map((line, idx) => ({
            productId: line.product.id,
            variantId: line.item.variantId,
            productNameSnapshot: line.product.name,
            skuSnapshot: line.product.sku,
            unitPrice: breakdown.lines[idx].unitPrice,
            quantity: line.quantity,
            subtotal: breakdown.lines[idx].subtotal,
          })),
        },
      } as Prisma.OrderUncheckedCreateInput,
    })) as Order;
    await tx.orderDraft.update({
      where: { id: draft.id },
      data: { state: "CONVERTED", orderId: created.id, idempotencyKey },
    });
    return created;
  };

  let order: Order;
  try {
    const anyDb = db as unknown as { $transaction?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
    order = typeof anyDb.$transaction === "function" ? await anyDb.$transaction(writeOrder) : await writeOrder(db);
  } catch (err) {
    // A concurrent confirmation won the race on the unique idempotencyKey.
    if ((err as { code?: string })?.code === "P2002") {
      const existing = await db.order.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return {
          orderId: existing.id,
          orderNumber: existing.orderNumber,
          status: existing.status,
          total: Number(existing.total),
          currency: existing.currency,
          created: false,
          rules,
        };
      }
    }
    throw err;
  }

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
      where: { workspaceId: ctx.workspaceId, conversationId: draft.conversationId, sku: primary.product.sku },
    }).catch(() => [] as Array<Record<string, unknown>>);
    if (shownRows.some((r) => r.type === "OFFER_SHOWN")) {
      const offerQty = shownRows
        .filter((r) => r.type === "OFFER_SHOWN")
        .map((r) => Number((r.payload as { quantity?: number } | null)?.quantity ?? 0))
        .reduce((a: number, b: number) => Math.max(a, b), 0);
      if (!offerQty || primary.quantity >= offerQty) {
        await recordSalesEvent(db, {
          workspaceId: ctx.workspaceId,
          type: "OFFER_ACCEPTED",
          conversationId: draft.conversationId,
          customerId: draft.customerId,
          orderId: order.id,
          productId: primary.product.id,
          sku: primary.product.sku,
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
        productId: primary.product.id,
        sku: primary.product.sku,
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
  // Realtime: قائمة الطلبات تتحدّث لحظيًا.
  void publishRealtime(db, {
    workspaceId: ctx.workspaceId,
    type: "order.created",
    conversationId: draft.conversationId ?? undefined,
    entityId: order.id,
  });
  if (order.status === "CONFIRMED") {
    await eventBus.publish(
      makeEvent("OrderConfirmed", ctx.workspaceId, { orderId: order.id, customerId: draft.customerId, conversationId: draft.conversationId })
    );
  }

  // ترحيل الطلب لتلجرام — مرة واحدة عند إنشاء الطلب الرسمي (المسودة ما بتترحّل).
  // المصدر الأول: إعدادات المساحة (نفس اللي تنحفظ من الواجهة)، وبعدها متغيرات البيئة.
  try {
    const tg = await (db as any).telegramOrderSettings?.findUnique?.({
      where: { workspaceId: ctx.workspaceId },
      select: { enabled: true, botTokenEnc: true, chatId: true, topicId: true },
    });
    let token: string | undefined;
    let chatId: string | undefined;
    let topicId: string | undefined;
    if (tg?.enabled && tg.botTokenEnc && tg.chatId) {
      const { decryptSecret } = await import("@/core/crypto");
      token = decryptSecret(tg.botTokenEnc);
      chatId = tg.chatId;
      topicId = tg.topicId ?? undefined;
    } else {
      token = process.env.TELEGRAM_BOT_TOKEN;
      chatId = process.env.TELEGRAM_ORDER_CHAT_ID;
    }
    if (token && chatId) {
      const { getTelegramClient } = await import("@/modules/channels/telegram/client");
      const { orderNotificationText, telegramOrderPiiEnabled } = await import("./notify");
      // سيستم 1 — بلا بيانات زبون افتراضيًا؛ المالك يفعّلها صريحًا.
      const text = orderNotificationText({
        orderNumber,
        // P22 — كل منتجات الطلب في سطر واحد (الكمية مدمجة بالاسم عند التعدد).
        productName:
          orderLines.length === 1
            ? primary.product.name
            : orderLines.map((l) => `${l.product.name} × ${l.quantity}`).join("، "),
        quantity: orderLines.length === 1 ? primary.quantity : null,
        total: breakdown.total,
        currency: breakdown.currency,
        status,
        customerName: customer?.name,
        customerPhone: customer?.phone,
        includePii: telegramOrderPiiEnabled(),
      });
      const thread = topicId ? Number(topicId) : NaN;
      const result = await getTelegramClient().sendMessage(token, chatId, {
        text,
        ...(Number.isInteger(thread) && thread > 0 ? { messageThreadId: thread } : {}),
      });
      // سجل الإرسال = مصدر شعار «تم ترحيله للتلجرام» بالقائمة.
      await recordAudit(db, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        action: "order.telegram_notified",
        entityType: "Order",
        entityId: order.id,
        metadata: { orderNumber, chatId, messageId: result.messageId },
      });
      // Realtime: شعار «تم ترحيله للتلجرام» يظهر فورًا.
      void publishRealtime(db, {
        workspaceId: ctx.workspaceId,
        type: "order.telegram",
        entityId: order.id,
      });
    }
  } catch {
    // الإشعار best-effort — غيابه ما يوقف إنشاء الطلب
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
    makeEvent(to === "CANCELLED" ? "OrderCancelled" : "OrderStateChanged", ctx.workspaceId, {
      orderId,
      conversationId: order.conversationId ?? undefined,
      from: order.status,
      to,
    })
  );
  // Phase 1.6 — a cancelled order must not receive scheduled follow-ups.
  if (to === "CANCELLED") {
    try {
      const { cancelFollowUpsFor } = await import("@/modules/automation/followup-service");
      await cancelFollowUpsFor(db, ctx.workspaceId, order.customerId, null);
    } catch {
      // follow-up cleanup is best-effort — the cancellation itself stands.
    }
  }
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
  | { ok: false; reason: "EDIT_NEEDS_REVIEW"; orderNumber: string }
  | { ok: false; reason: "NOT_EDITABLE"; orderNumber: string; statusLabel: string };

/** Orders a chat message may still mutate. Anything CONFIRMED or later is
 *  final: a single message can never rewrite a placed order — it is logged as
 *  an edit request and must go through an explicit staff path. */
const CHAT_EDITABLE_STATUSES: OrderStatus[] = ["NEW", "CONFIRMATION_PENDING"];

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

  // Phase 0.3 — a confirmed/processing/shipped order is never mutated from
  // chat. The request is recorded (history preserved) and surfaced to staff.
  if (!CHAT_EDITABLE_STATUSES.includes(order.status)) {
    await recordAudit(db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: "order.edit_requested",
      entityType: "Order",
      entityId: order.id,
      ip: ctx.ip,
      metadata: {
        orderNumber: order.orderNumber,
        status: order.status,
        requested: {
          quantity: params.quantity ?? null,
          province: params.province ?? null,
          address: params.rawAddress ?? null,
          notes: params.notes ?? null,
          phone: params.phone ?? null,
        },
      },
    });
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
    // A multi-item order has no unambiguous "which item" from a chat message —
    // never guess: hand it to a human instead of mangling other items.
    if (items.length !== 1) {
      return { ok: false, reason: "EDIT_NEEDS_REVIEW", orderNumber: order.orderNumber };
    }
    const item = items[0];
    // Price snapshot stays locked (item.unitPrice — never a live Product
    // price); totals are recomputed through the same pricing engine as
    // creation, and the existing discount is carried over (it is only lost
    // when the new subtotal makes it invalid — the engine caps it).
    const breakdown = await calculatePricing(db, {
      workspaceId: ctx.workspaceId,
      product: { price: Number(item.unitPrice), currency: order.currency },
      quantity: params.quantity,
      province: newProvince,
      discount: Number(order.discount),
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
  } else if (data.province) {
    // Province moved without a quantity change: recompute ONLY the delivery
    // fee from the stored subtotal. Never drop the discount and never sum just
    // the first item — the total stays subtotal − discount + delivery.
    const delivery = await quoteDelivery(db, {
      workspaceId: ctx.workspaceId,
      province: newProvince,
      subtotal: Number(order.subtotal),
    });
    if (!delivery.available) {
      throw new AppError("Delivery not available for this province", 422, "DELIVERY_UNAVAILABLE");
    }
    data.deliveryFee = delivery.fee;
    data.total = Number(order.subtotal) - Number(order.discount) + delivery.fee;
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
  // + شعار «تم ترحيله للتلجرام» من سجل الإرسال الفعلي لكل طلب.
  const notified = await telegramNotifiedOrderIds(db, params.workspaceId, page.map((o) => o.id));
  const items = page.map((o) => ({ ...withoutClickSecrets(o), telegramNotified: notified.has(o.id) }));
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

