import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { readSchema } from "@/modules/conversations/schemas";
import { markConversationRead, markConversationUnread } from "@/modules/conversations/service";

type Params = { id: string };

export const POST = createHandler(
  { body: readSchema, permission: "conversations.read" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const updated = body.isRead
      ? await markConversationRead(prisma, auth!, id)
      : await markConversationUnread(prisma, auth!, id);
    return ok({ id: updated.id, unreadCount: updated.unreadCount });
  }
);
