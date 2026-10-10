import { AppError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { decryptSecret } from "@/core/crypto";
import { getInstagramClient } from "./client";

/**
 * Instagram comment moderation service (P5-B). Operator-driven only.
 * Edge shapes follow the public Instagram Graph docs; LIVE verification is
 * BLOCKED until an approved professional account connects — tests assert
 * OUR request shapes and policy gates against stubs.
 */

const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600_000;

async function tokenFor(db: Db, workspaceId: string, igId: string): Promise<string> {
  // Two-step lookup (no relation include): identical on Postgres and doubles.
  const account = await (db as any).channelAccount?.findFirst?.({
    where: { provider: "INSTAGRAM", externalAccountId: igId },
  });
  const channel = (account as { channelId?: string } | null)?.channelId
    ? ((await db.channel.findUnique({
        where: { id: (account as { channelId: string }).channelId },
        select: { workspaceId: true, status: true },
      })) as { workspaceId: string; status: string } | null)
    : null;
  if (!account || channel?.workspaceId !== workspaceId || channel?.status !== "CONNECTED") {
    throw new AppError("Instagram account is not connected in this workspace", 422, "ACCOUNT_NOT_CONNECTED");
  }
  try {
    return decryptSecret((account as { encryptedCredentials: string }).encryptedCredentials);
  } catch {
    throw new AppError("Account token unreadable", 500, "TOKEN_DECRYPT_FAILED");
  }
}

export async function replyToIgCommentPublic(
  db: Db,
  ctx: ActorContext,
  input: { igId: string; commentId: string; text: string }
): Promise<{ id: string }> {
  if (!input.text.trim() || input.text.length > 2000) {
    throw new AppError("Invalid reply text", 422, "INVALID_BODY");
  }
  const token = await tokenFor(db, ctx.workspaceId, input.igId);
  const res = await getInstagramClient().replyToComment(token, input.commentId, input.text.trim());
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "comment.public_replied",
    entityType: "Channel",
    entityId: input.igId,
    metadata: { commentId: input.commentId, replyId: res.id, channel: "INSTAGRAM" },
  });
  return res;
}

export async function hideIgComment(
  db: Db,
  ctx: ActorContext,
  input: { igId: string; commentId: string; hidden: boolean }
): Promise<{ ok: boolean }> {
  const token = await tokenFor(db, ctx.workspaceId, input.igId);
  const res = await getInstagramClient().setCommentHidden(token, input.commentId, input.hidden);
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: input.hidden ? "comment.hidden" : "comment.unhidden",
    entityType: "Channel",
    entityId: input.igId,
    metadata: { commentId: input.commentId, channel: "INSTAGRAM" },
  });
  return res;
}

export async function replyToIgCommentPrivate(
  db: Db,
  ctx: ActorContext,
  input: { igId: string; pageId: string; commentId: string; text: string; commentCreatedAt?: string | Date | null }
): Promise<{ messageId: string }> {
  if (!input.text.trim() || input.text.length > 2000) {
    throw new AppError("Invalid reply text", 422, "INVALID_BODY");
  }
  if (input.commentCreatedAt) {
    const created = new Date(input.commentCreatedAt).getTime();
    if (Number.isFinite(created) && Date.now() - created > PRIVATE_REPLY_WINDOW_MS) {
      throw new AppError("Private replies close 7 days after the comment", 422, "PRIVATE_REPLY_EXPIRED");
    }
  }
  try {
    await (db as any).webhookEvent.create({
      data: {
        workspaceId: ctx.workspaceId,
        channelType: "INSTAGRAM",
        externalEventId: `ig-private-reply:${input.commentId}`,
        source: "ig-comment-private",
        payload: { commentId: input.commentId, igId: input.igId },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      throw new AppError("A private reply was already sent for this comment", 409, "PRIVATE_REPLY_DUPLICATE");
    }
    throw err;
  }
  const token = await tokenFor(db, ctx.workspaceId, input.igId);
  const res = await getInstagramClient().sendPrivateReply(token, input.pageId, input.commentId, input.text.trim());
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "comment.private_replied",
    entityType: "Channel",
    entityId: input.igId,
    metadata: { commentId: input.commentId, channel: "INSTAGRAM" },
  });
  return res;
}
