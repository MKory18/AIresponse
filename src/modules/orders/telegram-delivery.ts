import { recordAudit } from "@/modules/audit/service";
import { publishRealtime } from "@/modules/realtime/events";
import type { Db } from "@/modules/customers/service";

/**
 * Sends the order notification once. Safe to retry: an order that already has
 * its `order.telegram_notified` audit row is skipped. Throws when Telegram
 * fails, so the caller can queue a retry. No settings = nothing to send.
 */
export async function deliverOrderTelegram(
  db: Db,
  params: { workspaceId: string; userId: string; orderId: string }
): Promise<void> {
  const anyDb = db as any;
  const settings = await anyDb.telegramOrderSettings?.findUnique?.({
    where: { workspaceId: params.workspaceId },
    select: { enabled: true, botTokenEnc: true, chatId: true, topicId: true },
  });
  let token: string | undefined;
  let chatId: string | undefined;
  let topicId: string | undefined;
  if (settings?.enabled && settings.botTokenEnc && settings.chatId) {
    const { decryptSecret } = await import("@/core/crypto");
    token = decryptSecret(settings.botTokenEnc);
    chatId = settings.chatId;
    topicId = settings.topicId ?? undefined;
  } else {
    token = process.env.TELEGRAM_BOT_TOKEN;
    chatId = process.env.TELEGRAM_ORDER_CHAT_ID;
  }
  if (!token || !chatId) return;

  const alreadySent = await db.auditLog.findFirst({
    where: {
      workspaceId: params.workspaceId,
      action: "order.telegram_notified",
      entityType: "Order",
      entityId: params.orderId,
    },
    select: { id: true },
  });
  if (alreadySent) return;

  const order = await db.order.findUnique({ where: { id: params.orderId } });
  if (!order || order.workspaceId !== params.workspaceId) return;
  const items = await db.orderItem.findMany({ where: { orderId: order.id } });
  const customer = await db.customer.findUnique({ where: { id: order.customerId } });

  const { getTelegramClient } = await import("@/modules/channels/telegram/client");
  const { orderNotificationText, telegramOrderPiiEnabled } = await import("./notify");
  // سيستم 1 — بلا بيانات زبون افتراضيًا؛ المالك يفعّلها صريحًا.
  const text = orderNotificationText({
    orderNumber: order.orderNumber,
    // P22 — كل منتجات الطلب في سطر واحد (الكمية مدمجة بالاسم عند التعدد).
    productName:
      items.length === 1
        ? items[0].productNameSnapshot
        : items.map((i) => `${i.productNameSnapshot} × ${i.quantity}`).join("، "),
    quantity: items.length === 1 ? items[0].quantity : null,
    total: Number(order.total),
    currency: order.currency,
    status: order.status,
    customerName: customer?.name,
    customerPhone: (order as { recipientPhone?: string | null }).recipientPhone ?? customer?.phone,
    includePii: telegramOrderPiiEnabled(),
  });
  const thread = topicId ? Number(topicId) : NaN;
  const result = await getTelegramClient().sendMessage(token, chatId, {
    text,
    ...(Number.isInteger(thread) && thread > 0 ? { messageThreadId: thread } : {}),
  });
  // سجل الإرسال = مصدر شعار «تم ترحيله للتلجرام» بالقائمة.
  await recordAudit(db, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    action: "order.telegram_notified",
    entityType: "Order",
    entityId: order.id,
    metadata: { orderNumber: order.orderNumber, chatId, messageId: result.messageId },
  });
  // Realtime: شعار «تم ترحيله للتلجرام» يظهر فورًا.
  void publishRealtime(db, {
    workspaceId: params.workspaceId,
    type: "order.telegram",
    entityId: order.id,
  });
}
