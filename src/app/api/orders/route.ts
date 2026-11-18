import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listOrders } from "@/modules/orders/order-service";
import { createManualOrder, manualOrderSchema } from "@/modules/orders/manual-order";

const listQuerySchema = z.object({
  status: z.enum(["NEW", "CONFIRMATION_PENDING", "CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "RETURNED"]).optional(),
  confirmationStatus: z.enum(["PENDING", "CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT", "DECLINED"]).optional(),
  customerId: z.string().cuid().optional(),
  productId: z.string().cuid().optional(),
  tab: z.enum(["all", "review", "awaiting", "sealed", "cancelled"]).optional(),
  q: z.string().max(64).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: listQuerySchema, permission: "orders.read" },
  async ({ auth, query }) => {
    const result = await listOrders(prisma, { workspaceId: auth!.workspaceId, ...query });
    // حذف الطلبات للمالك فقط — الواجهة تخفي إجراء الحذف عن غيره.
    return ok({ ...result, canDelete: auth!.can("orders.delete") });
  }
);

/** «طلب يدوي» (3.2): بيمرّ بنفس القواعد والتسعير، ويثبّت فورًا. التفاصيل بـ `modules/orders/manual-order.ts`. */
export const POST = createHandler(
  { body: manualOrderSchema, permission: "orders.write", rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ auth, body, req }) => {
    const result = await createManualOrder(
      prisma,
      { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined },
      body
    );
    return ok(result, result.created ? 201 : 200);
  }
);
