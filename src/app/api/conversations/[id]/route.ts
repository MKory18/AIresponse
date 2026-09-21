import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { updateConversationSchema } from "@/modules/conversations/schemas";
import { getConversationDetail, updateConversation } from "@/modules/conversations/service";

type Params = { id: string };

export const GET = createHandler(
  { permission: "conversations.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const conversation = await getConversationDetail(prisma, auth!, id);
    return ok(conversation);
  }
);

export const PATCH = createHandler(
  { body: updateConversationSchema, permission: "conversations.reply" },
  async ({ auth, body, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const updated = await updateConversation(prisma, ctx, id, body);
    return ok(updated);
  }
);
