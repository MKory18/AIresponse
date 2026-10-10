import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { hideIgComment } from "@/modules/channels/instagram/comments";

/** Hide / unhide an Instagram comment (channels.send_human). */
export const POST = createHandler(
  {
    body: z.object({
      igId: z.string().min(1).max(64),
      commentId: z.string().min(1).max(128),
      hidden: z.boolean().default(true),
    }),
    permission: "channels.send_human",
  },
  async ({ auth, body, req }) => {
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined };
    return ok(await hideIgComment(prisma, ctx, body));
  }
);
