import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { sealOrder } from "@/modules/orders/reader/actions";

type Params = { id: string };

/** «ثبّت الآن» — تثبيت يدوي (غير مرحّل لبرّا بهالحزمة). */
export const POST = createHandler({ permission: "orders.seal" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const r = await sealOrder(prisma, { workspaceId: auth!.workspaceId, orderId: id, actor: { userId: auth!.userId, workspaceId: auth!.workspaceId } });
  return ok(r);
});
