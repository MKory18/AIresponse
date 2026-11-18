import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { releaseOrder } from "@/modules/orders/reader/actions";

type Params = { id: string };

/** «أطلق» — شيل الإيقاف؛ إذا ما ضل سبب مراجعة بيرجع بمهلة جديدة. */
export const POST = createHandler({ permission: "orders.seal" }, async ({ auth, params }) => {
  const { id } = params as Params;
  return ok(await releaseOrder(prisma, { workspaceId: auth!.workspaceId, orderId: id, actor: { userId: auth!.userId, workspaceId: auth!.workspaceId } }));
});
