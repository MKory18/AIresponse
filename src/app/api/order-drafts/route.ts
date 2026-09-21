import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";

const listQuerySchema = z.object({
  conversationId: z.string().cuid().optional(),
  state: z.enum(["EMPTY", "COLLECTING", "READY", "CONFIRMING", "CONFIRMED", "CONVERTED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = createHandler(
  { query: listQuerySchema, permission: "orders.read" },
  async ({ auth, query }) => {
    const where: Record<string, unknown> = { workspaceId: auth!.workspaceId };
    if (query.conversationId) where.conversationId = query.conversationId;
    if (query.state) where.state = query.state;
    const drafts = await prisma.orderDraft.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: query.limit ?? 25,
    });
    return ok({ items: drafts });
  }
);
