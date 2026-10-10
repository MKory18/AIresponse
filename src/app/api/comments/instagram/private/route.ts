import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { replyToIgCommentPrivate } from "@/modules/channels/instagram/comments";

/** Single private reply (one per comment, 7-day window — provider rules). */
export const POST = createHandler(
  {
    body: z.object({
      igId: z.string().min(1).max(64),
      pageId: z.string().min(1).max(64),
      commentId: z.string().min(1).max(128),
      text: z.string().trim().min(1).max(2000),
      commentCreatedAt: z.string().datetime({ offset: true }).optional(),
    }),
    permission: "channels.send_human",
  },
  async ({ auth, body, req }) => {
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined };
    return ok(await replyToIgCommentPrivate(prisma, ctx, body));
  }
);
