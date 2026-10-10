import { AppError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { decryptSecret } from "@/core/crypto";
import { getFacebookCommentsClient } from "./comments-client";

/**
 * Facebook comment moderation service (P5-A). Official Graph edges only.
 * No auto-replies: every action is operator-driven (AI comment replies are
 * P6 territory). Private replies are guarded to exactly one per comment
 * (provider rule) via WebhookEvent idempotency + a local 7-day check.
 */

export interface ModeratedComment {
  commentId: string;
  postId?: string | null;
  text?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  /** ISO timestamp (JSON-safe for WebhookEvent payloads). */
  createdAt?: string | null;
}

const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600_000;

async function pageTokenFor(db: Db, workspaceId: string, pageId: string): Promise<string> {
  // Two-step lookup (no relation include): identical on Postgres and doubles.
  const account = await (db as any).channelAccount?.findFirst?.({
    where: { provider: "FACEBOOK", externalAccountId: pageId },
  });
  const channel = (account as { channelId?: string } | null)?.channelId
    ? ((await db.channel.findUnique({
        where: { id: (account as { channelId: string }).channelId },
        select: { workspaceId: true, status: true },
      })) as { workspaceId: string; status: string } | null)
    : null;
  if (!account || channel?.workspaceId !== workspaceId || channel?.status !== "CONNECTED") {
    throw new AppError("Page is not connected in this workspace", 422, "PAGE_NOT_CONNECTED");
  }
  try {
    return decryptSecret((account as { encryptedCredentials: string }).encryptedCredentials);
  } catch {
    throw new AppError("Page token unreadable", 500, "TOKEN_DECRYPT_FAILED");
  }
}

export async function replyToCommentPublic(
  db: Db,
  ctx: ActorContext,
  input: { pageId: string; objectId: string; text: string }
): Promise<{ id: string }> {
  if (!input.text.trim() || input.text.length > 2000) {
    throw new AppError("Invalid reply text", 422, "INVALID_BODY");
  }
  const token = await pageTokenFor(db, ctx.workspaceId, input.pageId);
  const res = await getFacebookCommentsClient().replyPublic(token, input.objectId, input.text.trim());
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "comment.public_replied",
    entityType: "Channel",
    entityId: input.pageId,
    metadata: { objectId: input.objectId, replyId: res.id },
  });
  return res;
}

export async function hideComment(
  db: Db,
  ctx: ActorContext,
  input: { pageId: string; commentId: string; hidden: boolean }
): Promise<{ ok: boolean }> {
  const token = await pageTokenFor(db, ctx.workspaceId, input.pageId);
  const res = await getFacebookCommentsClient().setHidden(token, input.commentId, input.hidden);
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: input.hidden ? "comment.hidden" : "comment.unhidden",
    entityType: "Channel",
    entityId: input.pageId,
    metadata: { commentId: input.commentId },
  });
  return res;
}

export async function replyToCommentPrivate(
  db: Db,
  ctx: ActorContext,
  input: { pageId: string; commentId: string; text: string; commentCreatedAt?: string | Date | null }
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
  // Exactly-once per comment (provider allows a single private reply).
  try {
    await (db as any).webhookEvent.create({
      data: {
        workspaceId: ctx.workspaceId,
        channelType: "FACEBOOK",
        externalEventId: `fb-private-reply:${input.commentId}`,
        source: "fb-comment-private",
        payload: { commentId: input.commentId, pageId: input.pageId },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      throw new AppError("A private reply was already sent for this comment", 409, "PRIVATE_REPLY_DUPLICATE");
    }
    throw err;
  }
  const token = await pageTokenFor(db, ctx.workspaceId, input.pageId);
  const res = await getFacebookCommentsClient().replyPrivate(token, input.pageId, input.commentId, input.text.trim());
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "comment.private_replied",
    entityType: "Channel",
    entityId: input.pageId,
    metadata: { commentId: input.commentId },
  });
  return res;
}

/** Parse feed/comment webhook values into moderated comments (pure). */
export function normalizeFeedComments(payload: unknown): ModeratedComment[] {
  const out: ModeratedComment[] = [];
  const entries = (payload as { entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] }).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "feed" && change.field !== "comments") continue;
      const v = (change.value ?? {}) as Record<string, unknown>;
      const item = v.item as string | undefined;
      // Only real comments/replies — likes, reactions and shares carry no
      // comment_id and must never enter the moderation path.
      if (item !== undefined && item !== "comment" && item !== "reply") continue;
      const commentId = v.comment_id as string | undefined;
      if (!commentId) continue;
      const from = v.from as { id?: string; name?: string } | undefined;
      const created = v.created_time as number | undefined;
      out.push({
        commentId,
        postId: (v.post_id as string) ?? (v.parent_id as string) ?? null,
        text: (v.message as string) ?? null,
        authorId: from?.id ?? null,
        authorName: from?.name ?? null,
        createdAt: typeof created === "number" ? new Date(created * 1000).toISOString() : null,
      });
    }
  }
  return out;
}
