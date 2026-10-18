import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listOrders } from "@/modules/orders/order-service";

const listQuerySchema = z.object({
  status: z.enum(["NEW", "CONFIRMATION_PENDING", "CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "RETURNED"]).optional(),
  confirmationStatus: z.enum(["PENDING", "CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT", "DECLINED"]).optional(),
  customerId: z.string().cuid().optional(),
  productId: z.string().cuid().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: listQuerySchema, permission: "orders.read" },
  async ({ auth, query }) => {
    const result = await listOrders(prisma, { workspaceId: auth!.workspaceId, ...query });
    // حذف الطلبات للمالك فقط — الواجهة تخفي إجراء الحذف عن غيره.
    return ok({ ...result, canDelete: auth!.role === "OWNER" });
  }
);
