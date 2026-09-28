import { childLogger } from "@/core/logger";
import { decryptSecret } from "@/core/crypto";
import { getFacebookClient } from "./facebook/client";
import { FacebookApiError } from "./facebook/types";
import { canSendToCustomer } from "./facebook/policy";
import { generatePublicMediaUrl } from "@/modules/media/service";
import type { Db } from "@/modules/customers/service";

const log = childLogger("outbound");

export interface DispatchOutboundParams {
  workspaceId: string;
  conversationId: string;
  /** Inbound message this reply answers — part of the idempotency identity. */
  sourceMessageId: string;
  text: string;
  senderType?: "AI" | "HUMAN";
  senderId?: string;
  /** Optional media asset ID to attach (image/video/audio/file). */
  mediaId?: string | null;
}

export interface DispatchOutboundResult {
  messageId: string;
  deliveryStatus: "SENT" | "FAILED" | "QUEUED" | "SKIPPED_DUPLICATE";
  /** Delivery status of the pre-existing row when SKIPPED_DUPLICATE. */
  existingStatus?: string;
  externalMessageId?: string;
  error?: string;
  channelId?: string;
  pageId?: string;
  recipientId?: string;
  graphCode?: string;
  durationMs?: number;
}

/** Human agent reply through the SAME ChannelSender + policy + idempotency. */
export async function sendHumanReply(
  db: Db,
  params: { workspaceId: string; conversationId: string; userId: string; text: string; idempotencyKey?: string }
): Promise<DispatchOutboundResult> {
  return dispatchOutbound(db, {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sourceMessageId: params.idempotencyKey ?? `human:${params.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    text: params.text,
    senderType: "HUMAN",
    senderId: params.userId,
  });
}

/**
 * ChannelSender — the ONLY outbound path to external channels.
 *
 * Guarantees:
 * - Outbound idempotency: `outboundIdempotencyKey = conversationId:sourceMessageId`
 *   has a UNIQUE constraint; a repeated execution never double-sends.
 * - Retry without duplicates: a pre-existing SENT row returns SKIPPED_DUPLICATE;
 *   a FAILED/QUEUED/PENDING row is REUSED (same id, same key) and re-sent — so
 *   UI retry never creates a second row or a second Graph message.
 * - Recipient resolution from trusted DB state (ChannelIdentity) — never from
 *   AI output — scoped to this conversation's page via channelConversationId.
 * - Messaging policy (Meta 24h window, connection status, token expiry) is
 *   enforced before any Graph call.
 * - Transient failures → QUEUED (retryable); permanent → FAILED with
 *   providerErrorCode + providerErrorMessage + failedAt in metadata.
 *   Nothing fails silently: every outcome is logged with ids + duration.
 *   (No tokens, secrets, or API keys are ever logged.)
 */
export async function dispatchOutbound(
  db: Db,
  params: DispatchOutboundParams
): Promise<DispatchOutboundResult> {
  const started = Date.now();
  if (!params.text?.trim()) {
    return { messageId: "", deliveryStatus: "FAILED", error: "تعذر إرسال الرد — نص فارغ" };
  }
  const outboundKey = `${params.conversationId}:${params.sourceMessageId}`;

  // 1. Idempotency: SENT rows are terminal (skip); FAILED/QUEUED/PENDING rows
  // are reclaimed for resend under the same id — never a duplicate row.
  const existing = await (db as any).message.findUnique({
    where: { outboundIdempotencyKey: outboundKey },
    select: { id: true, deliveryStatus: true, externalMessageId: true },
  });
  if (existing && existing.deliveryStatus === "SENT") {
    return {
      messageId: existing.id,
      deliveryStatus: "SKIPPED_DUPLICATE",
      existingStatus: "SENT",
      externalMessageId: existing.externalMessageId ?? undefined,
      durationMs: Date.now() - started,
    };
  }

  // 2. Claim the slot atomically via the unique constraint, or reclaim the
  // failed row for this retry.
  let message;
  try {
    if (existing) {
      message = await db.message.update({
        where: { id: existing.id },
        data: { text: params.text, deliveryStatus: "PENDING", deliveryError: null },
      });
    } else {
      message = await db.message.create({
        data: {
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          senderType: params.senderType ?? "AI",
          senderId: params.senderId ?? "ai-agent",
          direction: "OUTBOUND",
          type: "TEXT",
          text: params.text,
          provider: "facebook",
          deliveryStatus: "PENDING",
          outboundIdempotencyKey: outboundKey,
        },
      });
    }
  } catch {
    const raced = await (db as any).message.findUnique({
      where: { outboundIdempotencyKey: outboundKey },
      select: { id: true, deliveryStatus: true, externalMessageId: true },
    });
    if (raced && raced.deliveryStatus === "SENT") {
      return {
        messageId: raced.id,
        deliveryStatus: "SKIPPED_DUPLICATE",
        existingStatus: "SENT",
        externalMessageId: raced.externalMessageId ?? undefined,
        durationMs: Date.now() - started,
      };
    }
    if (raced) {
      message = await db.message.update({
        where: { id: raced.id },
        data: { text: params.text, deliveryStatus: "PENDING", deliveryError: null },
      });
    } else {
      throw new Error("Outbound claim failed without duplicate");
    }
  }

  // 3. Load channel + account + recipient from trusted state.
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: params.conversationId },
    include: { channel: { include: { account: true } }, customer: true },
  });
  const channel = conversation.channel as {
    id: string;
    type: string;
    status: string;
    externalId?: string | null;
    account?: { id: string; encryptedCredentials: string; tokenExpiresAt: Date | null } | null;
  } | null;
  const account = channel?.account;
  const ctx = {
    messageId: message.id,
    conversationId: params.conversationId,
    channelId: channel?.id,
    pageId: channel?.externalId ?? undefined,
    provider: "facebook",
  };

  if (!channel || channel.type !== "FACEBOOK" || !account) {
    await markFailed(db, message.id, "CHANNEL_NOT_CONFIGURED", "القناة غير مربوطة");
    log.warn({ ...ctx, status: "FAILED", reason: "CHANNEL_NOT_CONFIGURED", durationMs: Date.now() - started }, "facebook.message.failed");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "CHANNEL_NOT_CONFIGURED", channelId: ctx.channelId, pageId: ctx.pageId, durationMs: Date.now() - started };
  }

  // 4. Messaging policy.
  const policy = canSendToCustomer({
    channelStatus: channel.status,
    tokenExpiresAt: account.tokenExpiresAt,
    lastCustomerMessageAt: conversation.lastCustomerMessageAt,
  });
  if (!policy.allowed) {
    await markFailed(db, message.id, `POLICY_${policy.reason}`, "تعذر الإرسال حسب سياسة المنصة");
    log.warn({ ...ctx, status: "FAILED", reason: `POLICY_${policy.reason}`, durationMs: Date.now() - started }, "facebook.message.failed");
    return { messageId: message.id, deliveryStatus: "FAILED", error: `POLICY_${policy.reason}`, channelId: ctx.channelId, pageId: ctx.pageId, durationMs: Date.now() - started };
  }

  // 5. Recipient from ChannelIdentity (trusted), scoped to this conversation's
  // page via channelConversationId — never AI output, never another page.
  const conversationPsid = (conversation as { channelConversationId?: string }).channelConversationId;
  let identity = conversationPsid
    ? await db.channelIdentity.findFirst({
        where: {
          workspaceId: params.workspaceId,
          customerId: conversation.customerId,
          channelType: "FACEBOOK",
          channelExternalId: conversationPsid,
        },
        select: { channelExternalId: true },
      })
    : null;
  identity ??= await db.channelIdentity.findFirst({
    where: { workspaceId: params.workspaceId, customerId: conversation.customerId, channelType: "FACEBOOK" },
    select: { channelExternalId: true },
  });
  if (!identity) {
    await markFailed(db, message.id, "RECIPIENT_NOT_FOUND", "تعذر العثور على المستلم");
    log.warn({ ...ctx, status: "FAILED", reason: "RECIPIENT_NOT_FOUND", durationMs: Date.now() - started }, "facebook.message.failed");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "RECIPIENT_NOT_FOUND", channelId: ctx.channelId, pageId: ctx.pageId, durationMs: Date.now() - started };
  }
  const recipientId = identity.channelExternalId;

  // 6. Prepare payload: text + optional media attachment via signed public URL.
  let payload: { text?: string; attachment?: { type: "image" | "video" | "audio" | "file"; payload: { url: string } } };
  if (params.mediaId) {
    const publicUrl = await generatePublicMediaUrl(db, params.workspaceId, params.mediaId, 60);
    // Determine attachment type from media asset
    const asset = await (db as any).mediaAsset.findUnique({
      where: { id: params.mediaId },
      select: { type: true, mimeType: true },
    });
    let attachType: "image" | "video" | "audio" | "file" = "file";
    if (asset?.type === "IMAGE") attachType = "image";
    else if (asset?.type === "VIDEO") attachType = "video";
    else if (asset?.type === "AUDIO") attachType = "audio";
    payload = {
      text: params.text?.trim() || undefined,
      attachment: { type: attachType, payload: { url: publicUrl } },
    };
  } else {
    payload = { text: params.text };
  }

  // 7. Send via the Facebook client (the only Graph caller).
  const client = getFacebookClient();
  let pageAccessToken: string;
  try {
    pageAccessToken = decryptSecret(account.encryptedCredentials);
  } catch {
    await markFailed(db, message.id, "TOKEN_DECRYPT_FAILED", "تعذر الاتصال بالصفحة");
    log.warn({ ...ctx, recipientId, status: "FAILED", reason: "TOKEN_DECRYPT_FAILED", durationMs: Date.now() - started }, "facebook.message.failed");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "TOKEN_DECRYPT_FAILED", channelId: ctx.channelId, pageId: ctx.pageId, recipientId, durationMs: Date.now() - started };
  }

  try {
    const result = await client.sendMessage(pageAccessToken, recipientId, payload);
    await db.message.update({
      where: { id: message.id },
      data: { deliveryStatus: "SENT", externalMessageId: result.messageId, deliveryError: null },
    });
    await db.channelAccount.update({
      where: { id: account!.id },
      data: { lastSendAt: new Date() },
    });
    await db.conversation.update({
      where: { id: params.conversationId },
      data: { lastAgentMessageAt: new Date() },
    });
    try {
      const { incrementUsage } = await import("@/core/analytics/usage-service");
      await incrementUsage(db as never, params.workspaceId, { messagesOutbound: 1 });
    } catch {
      // never break sending
    }
    log.info({ ...ctx, recipientId, status: "SENT", graphCode: result.graphCode, durationMs: Date.now() - started }, "facebook.message.sent");
    return { messageId: message.id, deliveryStatus: "SENT", externalMessageId: result.messageId, graphCode: result.graphCode, channelId: ctx.channelId, pageId: ctx.pageId, recipientId, durationMs: Date.now() - started };
  } catch (err) {
    const isTransient = err instanceof FacebookApiError && err.kind === ("TRANSIENT" as const);
    const code = err instanceof FacebookApiError ? `${err.code ?? ""}/${err.subcode ?? ""}` : "";
    const httpStatus = err instanceof FacebookApiError ? err.httpStatus : undefined;
    await db.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: isTransient ? "QUEUED" : "FAILED",
        deliveryError: err instanceof Error ? err.message : String(err),
        metadata: {
          providerErrorCode: code || "UNKNOWN",
          providerErrorMessage: err instanceof Error ? err.message : String(err),
          failedAt: new Date().toISOString(),
          retryable: isTransient,
          retryCount: 1,
        },
      },
    });
    log.warn({ ...ctx, recipientId, status: isTransient ? "QUEUED" : "FAILED", graphCode: code, httpStatus, durationMs: Date.now() - started }, "facebook.message.failed");
    return {
      messageId: message.id,
      deliveryStatus: isTransient ? "QUEUED" : "FAILED",
      error: err instanceof Error ? err.message : String(err),
      graphCode: code || undefined,
      channelId: ctx.channelId,
      pageId: ctx.pageId,
      recipientId,
      durationMs: Date.now() - started,
    };
  }
}

async function markFailed(db: Db, messageId: string, reason: string, arabicMessage?: string) {
  await db.message.update({
    where: { id: messageId },
    data: {
      deliveryStatus: "FAILED",
      deliveryError: arabicMessage ? `${reason}: ${arabicMessage}` : reason,
      metadata: {
        providerErrorCode: reason,
        providerErrorMessage: arabicMessage ?? reason,
        failedAt: new Date().toISOString(),
        retryable: false,
      },
    },
  });
}

/**
 * Recovers messages stuck in PENDING or QUEUED for too long.
 * This handles cases where the worker crashed mid-send or the network hung.
 * Uses the existing idempotency key to safely retry without duplicates.
 */
export async function recoverStuckOutboundMessages(
  db: Db,
  params: { workspaceId?: string; maxAgeMinutes?: number; limit?: number } = {}
): Promise<{ recovered: number; failed: number }> {
  const maxAgeMinutes = params.maxAgeMinutes ?? 10;
  const limit = params.limit ?? 50;
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);

  const whereClause: Record<string, unknown> = {
    direction: "OUTBOUND",
    deliveryStatus: { in: ["PENDING", "QUEUED"] },
    createdAt: { lt: cutoff },
  };
  if (params.workspaceId) {
    whereClause.workspaceId = params.workspaceId;
  }

  const stuckMessages = await db.message.findMany({
    where: whereClause,
    take: limit,
    select: {
      id: true,
      conversationId: true,
      workspaceId: true,
      text: true,
      senderType: true,
      senderId: true,
      outboundIdempotencyKey: true,
      deliveryStatus: true,
    },
  });

  let recovered = 0;
  let failed = 0;

  for (const msg of stuckMessages) {
    if (!msg.outboundIdempotencyKey) {
      // No idempotency key — mark as failed permanently
      await markFailed(db, msg.id, "STUCK_NO_IDEMPOTENCY", "تعذر استعادة الرسالة — مفتاح التكرار مفقود");
      failed++;
      continue;
    }

    try {
      const sourceMessageId = msg.outboundIdempotencyKey.slice(`${msg.conversationId}:`.length) || msg.id;
      const result = await dispatchOutbound(db, {
        workspaceId: msg.workspaceId,
        conversationId: msg.conversationId,
        sourceMessageId,
        text: msg.text ?? "",
        senderType: msg.senderType === "HUMAN" ? "HUMAN" : "AI",
        senderId: msg.senderId ?? undefined,
      });
      if (result.deliveryStatus === "SENT" || result.deliveryStatus === "SKIPPED_DUPLICATE") {
        recovered++;
      } else if (result.deliveryStatus === "QUEUED") {
        // Still queued — will be retried later
        recovered++;
      } else {
        failed++;
      }
    } catch (err) {
      log.error({ messageId: msg.id, err }, "stuck_message_recovery_failed");
      failed++;
    }
  }

  if (recovered > 0 || failed > 0) {
    log.info({ workspaceId: params.workspaceId, recovered, failed }, "stuck_outbound_messages_recovered");
  }
  return { recovered, failed };
}
