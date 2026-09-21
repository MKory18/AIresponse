import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "CLAIMED", "RESOLVED", "CANCELLED"]).optional(),
  reason: z.enum(["CUSTOMER_REQUEST", "COMPLAINT", "LOW_CONFIDENCE", "AI_FAILURE", "ORDER_BLOCKED", "PAYMENT_ISSUE", "INJECTION_DETECTED", "REPEATED_FAILURE", "MANUAL"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: listQuerySchema, permission: "handoffs.read" },
  async ({ auth, query }) => {
    const where: Record<string, unknown> = { workspaceId: auth!.workspaceId };
    if (query.status) where.status = query.status;
    if (query.reason) where.reason = query.reason;
    const handoffs = await prisma.humanHandoff.findMany({
      where: where as never,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: query.limit ?? 50,
      include: { conversation: { select: { id: true, status: true } } },
    } as never);
    return ok({ items: handoffs });
  }
);
