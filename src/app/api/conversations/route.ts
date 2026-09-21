import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { conversationListQuerySchema } from "@/modules/conversations/schemas";
import { listConversations } from "@/modules/conversations/service";

export const GET = createHandler(
  { query: conversationListQuerySchema, permission: "conversations.read" },
  async ({ auth, query }) => {
    const result = await listConversations(prisma, {
      workspaceId: auth!.workspaceId,
      status: query.status,
      aiState: query.aiState,
      unreadOnly: query.unreadOnly,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return ok(result);
  }
);
