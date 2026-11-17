import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { conversationListQuerySchema } from "@/modules/conversations/schemas";
import { listConversations } from "@/modules/conversations/service";
import { getAttention } from "@/modules/attention/service";

export const GET = createHandler(
  { query: conversationListQuerySchema, permission: "conversations.read" },
  async ({ auth, query }) => {
    // 3.1: «يحتاجك» = محادثات بنود الانتباه المسموحة لهالعضو (مصدر واحد مع العدّاد واللوحة).
    let ids = query.ids;
    if (query.view === "attention") {
      const att = await getAttention(prisma, auth!.workspaceId, auth!.can);
      const fromAttention = [...new Set(att.items.map((i) => /^\/conversations\?id=([^&]+)/.exec(i.href)?.[1]).filter((x): x is string => !!x))];
      ids = ids ? ids.filter((i) => fromAttention.includes(i)) : fromAttention;
    }
    const result = await listConversations(prisma, {
      workspaceId: auth!.workspaceId,
      ids,
      status: query.status,
      aiState: query.aiState,
      unreadOnly: query.unreadOnly || query.view === "new",
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
      priority: query.priority,
      assignee: query.assignee,
      actorUserId: auth!.userId,
      channelType: query.channelType,
      channelId: query.channelId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    return ok(result);
  }
);
