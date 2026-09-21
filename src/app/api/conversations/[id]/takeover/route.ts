import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { takeoverConversation } from "@/modules/conversations/service";

type Params = { id: string };

export const POST = createHandler(
  { permission: "conversations.reply" },
  async ({ auth, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const updated = await takeoverConversation(prisma, ctx, id);
    return ok(updated);
  }
);
