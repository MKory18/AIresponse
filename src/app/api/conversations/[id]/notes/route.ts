import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { noteSchema } from "@/modules/conversations/schemas";
import { postNote } from "@/modules/conversations/service";

type Params = { id: string };

/**
 * POST internal note — team-only record on the thread.
 * Requires conversations.reply (same trust as replying) but NEVER touches
 * ChannelSender: notes are Message rows flagged isNote and cannot be sent,
 * retried, or swept (see postNote docs). The row id is returned for UI use.
 */
export const POST = createHandler(
  { body: noteSchema, permission: "conversations.reply" },
  async ({ auth, body, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const note = await postNote(prisma, ctx, id, body.text);
    return ok({ note }, 201);
  }
);
