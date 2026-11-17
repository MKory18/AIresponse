import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { holdOrder } from "@/modules/orders/reader/actions";

type Params = { id: string };

/** «أوقف» — الطلب بيستنى موظف وما بيتثبّت لحاله. */
export const POST = createHandler({ permission: "orders.seal" }, async ({ auth, params }) => {
  const { id } = params as Params;
  return ok(await holdOrder(prisma, { workspaceId: auth!.workspaceId, orderId: id, actor: { userId: auth!.userId, workspaceId: auth!.workspaceId } }));
});
