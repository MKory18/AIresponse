import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { rereadConversation } from "@/modules/orders/reader/actions";

type Params = { id: string };

/** إعادة قراءة فورية للمحادثة («من الرسالة»). */
export const POST = createHandler({ permission: "conversations.reply" }, async ({ auth, params }) => {
  const { id } = params as Params;
  return ok(await rereadConversation(prisma, { workspaceId: auth!.workspaceId, conversationId: id }));
});
