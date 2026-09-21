import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { assignSchema } from "@/modules/conversations/schemas";
import { assignConversation } from "@/modules/conversations/service";

type Params = { id: string };

export const POST = createHandler(
  { body: assignSchema, permission: "conversations.assign" },
  async ({ auth, body, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const agentId = body.agentId === "@me" ? auth!.userId : body.agentId;
    const updated = await assignConversation(prisma, ctx, id, agentId);
    return ok(updated);
  }
);
