import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";

const listQuerySchema = z.object({
  status: z.enum(["SCHEDULED", "RUNNING", "SENT", "SKIPPED", "CANCELLED", "FAILED"]).optional(),
  customerId: z.string().cuid().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: listQuerySchema, permission: "followups.read" },
  async ({ auth, query }) => {
    const where: Record<string, unknown> = { workspaceId: auth!.workspaceId };
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    const followUps = await prisma.followUp.findMany({
      where,
      orderBy: { scheduledAt: "asc" },
      take: query.limit ?? 50,
    });
    return ok({ items: followUps });
  }
);
