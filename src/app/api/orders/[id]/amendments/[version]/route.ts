import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { resolveChangeRequest } from "@/modules/orders/reader/amend";

type Params = { id: string; version: string };

const schema = z.object({ decision: z.enum(["APPLIED", "REJECTED"]) });

/** قرار الموظف على طلب تعديل/إلغاء لطلب مثبّت: «تم التعديل بالـ OMS» (APPLIED) أو «مرفوض» (REJECTED). */
export const POST = createHandler({ permission: "orders.amend", body: schema }, async ({ auth, params, body }) => {
  const { id, version } = params as Params;
  return ok(
    await resolveChangeRequest(prisma, {
      workspaceId: auth!.workspaceId,
      orderId: id,
      version: Number(version),
      decision: body.decision,
      actor: { userId: auth!.userId },
    })
  );
});
