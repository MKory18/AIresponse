import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { hideIgComment, replyToIgCommentPrivate, replyToIgCommentPublic } from "@/modules/channels/instagram/comments";

const baseSchema = z.object({
  igId: z.string().min(1).max(64),
  commentId: z.string().min(1).max(128),
});

function ctxOf(auth: { userId: string; workspaceId: string }, req: { headers: { get: (k: string) => string | null } }) {
  return { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined };
}

/** Operator-driven public reply (channels.send_human). Edges per public IG docs. */
export const POST = createHandler(
  {
    body: baseSchema.extend({ text: z.string().trim().min(1).max(2000) }),
    permission: "channels.send_human",
  },
  async ({ auth, body, req }) => ok(await replyToIgCommentPublic(prisma, ctxOf(auth!, req), body))
);
