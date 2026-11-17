import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { z } from "zod";
import { editOrderFields } from "@/modules/orders/reader/actions";

type Params = { id: string };

const field = z.string().trim().max(1000).nullable().optional();
const schema = z.object({
  recipientName: field,
  recipientPhone: field,
  recipientAltPhone: field,
  deliveryAddress: field,
  province: field,
  notes: field,
}).strict();

/** تعديل موظف على حقول طلب غير مثبّت — القراءة اللاحقة ما بتستبدلها. */
export const PATCH = createHandler({ permission: "orders.write", body: schema }, async ({ auth, params, body }) => {
  const { id } = params as Params;
  const fields = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  return ok(await editOrderFields(prisma, { workspaceId: auth!.workspaceId, orderId: id, actor: { userId: auth!.userId, workspaceId: auth!.workspaceId }, fields }));
});
