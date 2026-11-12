import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedOrder } from "@/modules/orders/order-service";
import { autoHandoffState } from "@/modules/oms/auto-handoff";
import { getOmsConnectionView } from "@/modules/oms/connection";
import { handoffOrderToOms } from "@/modules/oms/handoff";

type Params = { id: string };

/** ط­ط§ظ„ط© ط§ظ„ط·ظ„ط¨ ط¨ط§ظ„ظ€ OMS: ط±ظ‚ظ…ظ‡ ظ‡ظ†ط§ظƒ آ· ط­ط§ظ„ط© ط§ظ„ط¥ط±ط³ط§ظ„ ط§ظ„طھظ„ظ‚ط§ط¦ظٹ آ· ط¢ط®ط± ط³ط¨ط¨ ط±ظپط¶. */
export const GET = createHandler({ permission: "orders.read" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const order = (await getOwnedOrder(prisma, auth!.workspaceId, id)) as unknown as {
    omsOrderId: string | null;
    omsOrderNumber: string | null;
    omsStatus: string | null;
    handedOffAt: Date | null;
  };
  const conn = await getOmsConnectionView(prisma, auth!.workspaceId);
  const job = await autoHandoffState(prisma, auth!.workspaceId, id, Boolean(order.omsOrderId));
  const sent = await prisma.auditLog.findFirst({
    where: { workspaceId: auth!.workspaceId, entityId: id, action: "oms.order_handed_off" },
    orderBy: { createdAt: "desc" },
  });
  const meta = (sent?.metadata ?? {}) as { priceAdjusted?: boolean; omsTotal?: number | null; omsCurrency?: string | null };
  return ok({
    connected: conn.configured && conn.isActive && conn.hasToken,
    omsOrderNumber: order.omsOrderNumber,
    omsStatus: order.omsStatus,
    handedOffAt: order.handedOffAt,
    sent: Boolean(order.omsOrderId),
    priceAdjusted: meta.priceAdjusted === true,
    omsTotal: meta.omsTotal ?? null,
    omsCurrency: meta.omsCurrency ?? null,
    job,
    canSend: auth!.can("orders.write"),
  });
});

/** آ«ط§ط¨ط¹طھظ‡ ظ„ظ„ظ€ OMS ظ‡ظ„ط£آ» â€” ظ†ظپط³ ظ…ظپطھط§ط­ ط¹ط¯ظ… ط§ظ„طھظƒط±ط§ط±طŒ ظپط§ظ„ط¶ط؛ط· ظ…ط±طھظٹظ† = ط·ظ„ط¨ ظˆط§ط­ط¯. */
export const POST = createHandler(
  { permission: "orders.write", rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ auth, params }) => {
    const { id } = params as Params;
    return ok(await handoffOrderToOms(prisma, { workspaceId: auth!.workspaceId, userId: auth!.userId }, id));
  }
);
