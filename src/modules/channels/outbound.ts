import { prisma as defaultPrisma } from "@/core/db/prisma";
import { childLogger } from "@/core/logger";
import { decryptSecret } from "@/core/crypto";
import { getFacebookClient } from "./facebook/client";
import { FacebookApiError } from "./facebook/types";
import { canSendToCustomer } from "./facebook/policy";
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
}

export interface DispatchOutboundResult {
  messageId: string;
  deliveryStatus: "SENT" | "FAILED" | "QUEUED" | "SKIPPED_DUPLICATE";
  externalMessageId?: string;
  error?: string;
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
 * ChannelSender â€” the ONLY outbound path to external channels.
 *
 * Guarantees:
 * - Outbound idempotency: `outboundIdempotencyKey = conversationId:sourceMessageId`
 *   has a UNIQUE constraint; a repeated execution never double-sends.
 * - Recipient resolution from trusted DB state (ChannelIdentity) â€” never from
 *   AI output.
 * - Messaging policy (Meta 24h window, connection status, token expiry) is
 *   enforced before any Graph call.
 * - Transient failures â†’ QUEUED (retryable by jobs); permanent â†’ FAILED.
 */
export async function dispatchOutbound(
  db: Db,
  params: DispatchOutboundParams
): Promise<DispatchOutboundResult> {
  if (!params.text?.trim()) {
    return { messageId: "", deliveryStatus: "FAILED", error: "تعذر إرسال الرد — نص فارغ" };
  }
  const outboundKey = `${params.conversationId}:${params.sourceMessageId}`;

  // 1. Idempotency (pre-check).
  const existing = await (db as any).message.findUnique({
    where: { outboundIdempotencyKey: outboundKey },
    select: { id: true, deliveryStatus: true, externalMessageId: true },
  });
  if (existing) {
    return {
      messageId: existing.id,
      deliveryStatus: "SKIPPED_DUPLICATE",
      externalMessageId: existing.externalMessageId ?? undefined,
    };
  }

  // 2. Claim the slot atomically via the unique constraint.
  let message;
  try {
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
  } catch {
    const raced = await (db as any).message.findUnique({
      where: { outboundIdempotencyKey: outboundKey },
      select: { id: true, deliveryStatus: true, externalMessageId: true },
    });
    if (raced) {
      return { messageId: raced.id, deliveryStatus: "SKIPPED_DUPLICATE", externalMessageId: raced.externalMessageId ?? undefined };
    }
    throw new Error("Outbound claim failed without duplicate");
  }

  // 3. Load channel + account + recipient from trusted state.
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: params.conversationId },
    include: { channel: { include: { account: true } }, customer: true },
  });
  const channel = conversation.channel as { type: string; status: string; account?: { id: string; encryptedCredentials: string; tokenExpiresAt: Date | null } | null } | null;
  const account = channel?.account;

  if (!channel || channel.type !== "FACEBOOK" || !account) {
    await markFailed(db, message.id, "CHANNEL_NOT_CONFIGURED");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "CHANNEL_NOT_CONFIGURED" };
  }

  // 4. Messaging policy.
  const policy = canSendToCustomer({
    channelStatus: channel.status,
    tokenExpiresAt: account.tokenExpiresAt,
    lastCustomerMessageAt: conversation.lastCustomerMessageAt,
  });
  if (!policy.allowed) {
    await markFailed(db, message.id, `POLICY_${policy.reason}`);
    return { messageId: message.id, deliveryStatus: "FAILED", error: `POLICY_${policy.reason}` };
  }

  // 5. Recipient from ChannelIdentity (trusted).
  const identity = await db.channelIdentity.findFirst({
    where: { workspaceId: params.workspaceId, customerId: conversation.customerId, channelType: "FACEBOOK" },
    select: { channelExternalId: true },
  });
  if (!identity) {
    await markFailed(db, message.id, "RECIPIENT_NOT_FOUND");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "RECIPIENT_NOT_FOUND" };
  }

  // 6. Send via the Facebook client (the only Graph caller).
  const client = getFacebookClient();
  let pageAccessToken: string;
  try {
    pageAccessToken = decryptSecret(account.encryptedCredentials);
  } catch {
    await markFailed(db, message.id, "TOKEN_DECRYPT_FAILED");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "TOKEN_DECRYPT_FAILED" };
  }

  try {
    const result = await client.sendMessage(pageAccessToken, identity.channelExternalId, { text: params.text });
    await db.message.update({
      where: { id: message.id },
      data: { deliveryStatus: "SENT", externalMessageId: result.messageId },
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
    log.info({ event: "facebook.message.sent", conversationId: params.conversationId, messageId: message.id });
    return { messageId: message.id, deliveryStatus: "SENT", externalMessageId: result.messageId };
  } catch (err) {
    const isTransient = err instanceof FacebookApiError && err.kind === ("TRANSIENT" as const);
    const code = err instanceof FacebookApiError ? `${err.code ?? ""}/${err.subcode ?? ""}` : "";
    await db.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: isTransient ? "QUEUED" : "FAILED",
        deliveryError: err instanceof Error ? err.message : String(err),
        metadata: { providerErrorCode: code, retryable: isTransient, retryCount: 1 },
      },
    });
    log.warn({ event: "facebook.message.failed", conversationId: params.conversationId, transient: isTransient, code });
    return {
      messageId: message.id,
      deliveryStatus: isTransient ? "QUEUED" : "FAILED",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function markFailed(db: Db, messageId: string, reason: string) {
  await db.message.update({
    where: { id: messageId },
    data: { deliveryStatus: "FAILED", deliveryError: reason, metadata: { retryable: false } },
  });
}
