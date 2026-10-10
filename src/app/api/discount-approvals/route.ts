import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listDiscountApprovals, requestDiscountApproval } from "@/modules/sales/pricing-policy";

/** P8 — طلبات موافقة الخصم: إنشاء (orders.discount) وقراءة (orders.read). */

export const GET = createHandler(
  {
    query: z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "INVALIDATED"]).optional() }).passthrough(),
    permission: "orders.read",
  },
  async ({ auth, query }) => {
    const items = await listDiscountApprovals(prisma, auth!.workspaceId, query.status);
    return ok({ items });
  }
);

export const POST = createHandler(
  {
    body: z
      .object({
        productId: z.string().min(1),
        discountPercent: z.number().min(0).max(90),
        conversationId: z.string().min(1).optional(),
        reason: z.string().max(500).optional(),
      })
      .strict(),
    permission: "orders.discount",
  },
  async ({ auth, body }) => {
    const result = await requestDiscountApproval(prisma, auth!, {
      productId: body.productId,
      discountPercent: body.discountPercent,
      conversationId: body.conversationId,
      reason: body.reason,
    });
    return ok(result, 201);
  }
);
