import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedOrder } from "@/modules/orders/order-service";
import { enqueueJob } from "@/modules/jobs/service";
import { AppError } from "@/core/errors";

type Params = { id: string };

/**
 * POST /api/orders/[id]/telegram — safe manual resend of the independent
 * order notification. A successful prior send is never repeated.
 */
export const POST = createHandler(
  { permission: "orders.write", rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const order = await getOwnedOrder(prisma, auth!.workspaceId, id);

    const sent = await prisma.auditLog.findFirst({
      where: {
        workspaceId: auth!.workspaceId,
        action: "order.telegram_sent",
        entityType: "Order",
        entityId: order.id,
      },
      select: { id: true },
    });
    if (sent) throw new AppError("تم إرسال إشعار هذا الطلب مسبقًا", 409, "TELEGRAM_ALREADY_SENT");

    const settings = await prisma.telegramOrderSettings.findUnique({
      where: { workspaceId: auth!.workspaceId },
      select: { enabled: true },
    });
    if (!settings?.enabled) throw new AppError("إشعارات تيليجرام غير مفعّلة", 422, "TELEGRAM_DISABLED");

    const job = await enqueueJob(prisma, {
      workspaceId: auth!.workspaceId,
      type: "notify_order_telegram",
      payload: { orderId: order.id },
      idempotencyKey: `telegram-order:${auth!.workspaceId}:${order.id}`,
      maxAttempts: 8,
    });
    return ok({ queued: true, jobId: job.id });
  }
);
