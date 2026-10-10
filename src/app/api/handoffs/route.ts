import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "CLAIMED", "RESOLVED", "CANCELLED"]).optional(),
  reason: z.enum(["CUSTOMER_REQUEST", "COMPLAINT", "LOW_CONFIDENCE", "AI_FAILURE", "ORDER_BLOCKED", "PAYMENT_ISSUE", "INJECTION_DETECTED", "REPEATED_FAILURE", "MANUAL"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  conversationId: z.string().cuid().optional(),
});

export const GET = createHandler(
  { query: listQuerySchema, permission: "handoffs.read" },
  async ({ auth, query }) => {
    const where: Record<string, unknown> = { workspaceId: auth!.workspaceId };
    if (query.status) where.status = query.status;
    if (query.reason) where.reason = query.reason;
    if (query.conversationId) where.conversationId = query.conversationId;
    // HumanHandoff has no Prisma relation to Conversation (scalar
    // conversationId only) — an `include: { conversation }` throws
    // "Unknown field `conversation`". Fetch plain rows, then hydrate the
    // conversation status in a second workspace-scoped query so the response
    // shape ({ ..., conversation: { id, status } | null }) stays compatible.
    const handoffs = await prisma.humanHandoff.findMany({
      where: where as never,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: query.limit ?? 50,
    } as never) as unknown as Array<Record<string, unknown> & { conversationId: string }>;
    const conversationIds = [...new Set(handoffs.map((h) => h.conversationId).filter(Boolean))];
    const conversations = conversationIds.length
      ? await prisma.conversation.findMany({
          where: { workspaceId: auth!.workspaceId, id: { in: conversationIds } },
          select: { id: true, status: true },
        })
      : [];
    const statusById = new Map(conversations.map((c) => [c.id, c.status]));
    const items = handoffs.map((h) => ({
      ...h,
      conversation: statusById.has(h.conversationId)
        ? { id: h.conversationId, status: statusById.get(h.conversationId) }
        : null,
    }));
    return ok({ items });
  }
);
