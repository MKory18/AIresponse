import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { z } from "zod";
import { cancelOrderByStaff } from "@/modules/orders/reader/actions";

type Params = { id: string };

const schema = z.object({ reason: z.string().max(500).optional() });

/** إلغاء طلب غير مثبّت (المثبّت = مسار طلب الإلغاء بالحزمة 1.6). */
export const POST = createHandler({ permission: "orders.cancel", body: schema }, async ({ auth, params, body }) => {
  const { id } = params as Params;
  return ok(await cancelOrderByStaff(prisma, { workspaceId: auth!.workspaceId, orderId: id, actor: { userId: auth!.userId, workspaceId: auth!.workspaceId }, reason: body.reason }));
});
