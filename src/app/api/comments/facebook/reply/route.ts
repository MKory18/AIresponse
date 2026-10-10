import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { replyToCommentPublic } from "@/modules/channels/facebook/comments";

const replySchema = z.object({
  pageId: z.string().min(1).max(64),
  commentId: z.string().min(1).max(128),
  text: z.string().trim().min(1).max(2000),
  objectId: z.string().min(1).max(128).optional(),
});

/** Operator-driven public reply under a post/comment (channels.send_human). */
export const POST = createHandler(
  { body: replySchema, permission: "channels.send_human" },
  async ({ auth, body, req }) => {
    const objectId = body.objectId ?? body.commentId;
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined };
    return ok(await replyToCommentPublic(prisma, ctx, { pageId: body.pageId, objectId, text: body.text }));
  }
);
