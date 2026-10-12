import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listConversationPages } from "@/modules/conversations/service";

/**
 * Inbox page switcher source: workspace channels with unread totals.
 * Secret-free rows under `conversations.read` (agents already hold it) —
 * no channel-management permission required, no cross-workspace leak.
 */
export const GET = createHandler(
  { permission: "conversations.read" },
  async ({ auth }) => ok({ pages: await listConversationPages(prisma, auth!.workspaceId) })
);
