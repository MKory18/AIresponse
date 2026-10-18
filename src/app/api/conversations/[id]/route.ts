import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { updateConversationSchema } from "@/modules/conversations/schemas";
import { purgeConversation, getConversationDetail, updateConversation } from "@/modules/conversations/service";

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

/**
 * DELETE — FULL PURGE: the thread, its messages, its cart, the AI memory it
 * seeded and its ancillary atoms are physically deleted (irreversible).
 * Orders survive as financial records, unlinked. Audited + event-published.
 * The soft-delete function stays available for tests/tooling.
 */
export const DELETE = createHandler(
  { permission: "conversations.delete" },
  async ({ auth, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const result = await purgeConversation(prisma, ctx, id);
    return ok({ ok: true, id, ...result });
  }
);
