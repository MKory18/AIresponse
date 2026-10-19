import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listLabConversations } from "@/modules/intelligence/queries";

const querySchema = z.object({
  /** فلتر بمعرّف الصفحة/القناة الفعلي — لا بالاسم. */
  channelId: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/intelligence/conversations — محادثات صفحات التجميع فقط. */
export const GET = createHandler(
  { query: querySchema, permission: "conversations.read" },
  async ({ auth, query }) => {
    const rows = await listLabConversations(prisma as never, {
      workspaceId: auth!.workspaceId,
      channelId: query.channelId,
      limit: query.limit,
    });
    return ok({ conversations: rows });
  }
);
