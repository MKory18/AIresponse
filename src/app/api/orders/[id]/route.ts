import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedOrder, transitionOrder } from "@/modules/orders/order-service";

type Params = { id: string };

export const GET = createHandler(
  { permission: "orders.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const order = await getOwnedOrder(prisma, auth!.workspaceId, id);
    const timeline = await prisma.auditLog.findMany({
      where: { workspaceId: auth!.workspaceId, entityId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return ok({ ...order, timeline });
  }
);

const patchSchema = z.object({
  status: z.enum(["CONFIRMATION_PENDING", "CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "RETURNED"]).optional(),
  notes: z.string().max(5000).optional(),
});

export const PATCH = createHandler(
  { body: patchSchema, permission: "orders.write" },
  async ({ auth, body, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    if (body.status) {
      const updated = await transitionOrder(prisma, ctx, id, body.status);
      return ok(updated);
    }
    const updated = await prisma.order.update({
      where: { id },
      data: { notes: body.notes },
    });
    return ok(updated);
  }
);
