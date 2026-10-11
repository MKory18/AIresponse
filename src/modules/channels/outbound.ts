import { childLogger } from "@/core/logger";
import { decryptSecret } from "@/core/crypto";
import { AppError } from "@/core/errors";
import { getFacebookClient } from "./facebook/client";
import { FacebookApiError } from "./facebook/types";
import { FacebookChannelAdapter } from "./facebook/adapter";
import { InstagramChannelAdapter } from "./instagram/adapter";
import { TelegramChannelAdapter } from "./telegram/adapter";
import { WhatsAppChannelAdapter } from "./whatsapp/adapter";
import { TikTokChannelAdapter } from "./tiktok/adapter";
import { getChannelAdapter } from "./registry";
import { ChannelNotSupportedError } from "./types";
import { canSendToCustomer } from "./facebook/policy";
import { canSendInstagram } from "./instagram/policy";
import { canSendTelegram } from "./telegram/policy";
import { canSendWhatsApp } from "./whatsapp/policy";
import { canSendTikTok } from "./tiktok/policy";
import { getInstagramClient } from "./instagram/client";
import { getTelegramClient, TelegramApiError } from "./telegram/client";
import { getWhatsAppClient, WhatsAppApiError } from "./whatsapp/client";
import { getTikTokClient, TikTokApiError } from "./tiktok/client";
import { InstagramApiError } from "./instagram/client";
import { generatePublicMediaUrl } from "@/modules/media/service";
import type { Db } from "@/modules/customers/service";
import type { ChannelType } from "@prisma/client";

const log = childLogger("outbound");

/** Channel types with a live outbound transport (P5). WEB has none. */
const OUTBOUND_CHANNELS = ["FACEBOOK", "INSTAGRAM", "TELEGRAM", "WHATSAPP", "TIKTOK"] as const;

function providerOf(channelType: string): string {
  return channelType.toLowerCase();
}

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
  /**
   * P9 — قالب معتمد (WhatsApp Business Platform فقط): المسار الرسمي
   * الوحيد للتسويق خارج نافذة 24h. القنوات الأخرى ترفضه صراحة.
   */
  template?: { name: string; language: string; variables?: Record<string, string> } | null;
}

/** حالات «الرسالة طلعت فعلًا» — نهائية لعدم التكرار (SENT وما بعده من إشارات التسليم). */
const ALREADY_SENT = new Set(["SENT", "DELIVERED", "READ"]);

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
 * Per-channel send policy (P5). Messenger keeps its dedicated 24h policy
 * inline; every other live channel decides here. Reasons surface as
 * POLICY_<reason> in delivery metadata (never silent, never faked).
 */
export function checkChannelPolicy(
  channelType: string,
  args: {
    channelStatus: string;
    tokenExpiresAt?: Date | string | null;
    lastCustomerMessageAt?: Date | string | null;
    tokenValid?: boolean;
    tiktokApproved?: boolean;
    template?: { name: string; language: string } | null;
  }
): { allowed: true } | { allowed: false; reason: string } {
  switch (channelType) {
    case "INSTAGRAM": {
      const d = canSendInstagram({
        channelStatus: args.channelStatus,
        tokenExpiresAt: args.tokenExpiresAt,
        lastCustomerMessageAt: args.lastCustomerMessageAt,
      });
      return d.allowed ? { allowed: true } : { allowed: false, reason: d.reason };
    }
    case "TELEGRAM": {
      const d = canSendTelegram({ channelStatus: args.channelStatus, tokenValid: args.tokenValid ?? false });
      return d.allowed ? { allowed: true } : { allowed: false, reason: d.reason };
    }
    case "WHATSAPP": {
      const d = canSendWhatsApp({
        channelStatus: args.channelStatus,
        tokenValid: args.tokenValid ?? false,
        lastCustomerMessageAt: args.lastCustomerMessageAt,
        template: args.template ?? null,
      });
      return d.allowed ? { allowed: true } : { allowed: false, reason: d.reason };
    }
    case "TIKTOK": {
      const d = canSendTikTok({
        channelStatus: args.channelStatus,
        accessApproved: args.tiktokApproved ?? false,
        lastCustomerMessageAt: args.lastCustomerMessageAt,
      });
      return d.allowed ? { allowed: true } : { allowed: false, reason: d.reason };
    }
    default:
      return { allowed: false, reason: "CHANNEL_NOT_CONFIGURED" };
  }
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
    select: { id: true, deliveryStatus: true, externalMessageId: true, metadata: true },
  });
  // P12: إشارات واتساب بتنقل الرسالة SENT ← DELIVERED ← READ — كلها «انبعتت»
  // (وإلا إعادة المحاولة بتبعت للزبون نفس الرسالة مرتين).
  if (existing && ALREADY_SENT.has(existing.deliveryStatus)) {
    return {
      messageId: existing.id,
      deliveryStatus: "SKIPPED_DUPLICATE",
      existingStatus: existing.deliveryStatus,
      externalMessageId: existing.externalMessageId ?? undefined,
      durationMs: Date.now() - started,
    };
  }

  // 2. Claim the slot atomically via the unique constraint, or reclaim the
  // failed row for this retry. The mediaId (if any) is persisted in metadata
  // so stale-recovery can resend the SAME attachment instead of text-only.
  // Preserve dual-send partial progress across reclaims: a row that already
  // delivered part 1 must resume at part 2 (never duplicate the attachment).
  const priorPart1ForClaim =
    existing && typeof (existing.metadata as { part1MessageId?: unknown } | null | undefined)?.part1MessageId === "string"
      ? ((existing.metadata as { part1MessageId: string }).part1MessageId)
      : null;
  const claimMetadata: Record<string, string> = {
    ...(params.mediaId ? { mediaId: params.mediaId } : {}),
    ...(priorPart1ForClaim ? { part1MessageId: priorPart1ForClaim } : {}),
  };
  const hasClaimMetadata = Object.keys(claimMetadata).length > 0;
  let message;
  try {
    if (existing) {
      message = await db.message.update({
        where: { id: existing.id },
        data: {
          text: params.text,
          deliveryStatus: "PENDING",
          deliveryError: null,
          ...(hasClaimMetadata ? { metadata: claimMetadata } : {}),
        },
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
          ...(hasClaimMetadata ? { metadata: claimMetadata } : {}),
        },
      });
    }
  } catch {
    const raced = await (db as any).message.findUnique({
      where: { outboundIdempotencyKey: outboundKey },
      select: { id: true, deliveryStatus: true, externalMessageId: true, metadata: true },
    });
    if (raced && ALREADY_SENT.has(raced.deliveryStatus)) {
      return {
        messageId: raced.id,
        deliveryStatus: "SKIPPED_DUPLICATE",
        existingStatus: raced.deliveryStatus,
        externalMessageId: raced.externalMessageId ?? undefined,
        durationMs: Date.now() - started,
      };
    }
    if (raced) {
      const racedPart1 =
        typeof (raced.metadata as { part1MessageId?: unknown } | null | undefined)?.part1MessageId === "string"
          ? ((raced.metadata as { part1MessageId: string }).part1MessageId)
          : priorPart1ForClaim;
      const racedClaim: Record<string, string> = {
        ...(params.mediaId ? { mediaId: params.mediaId } : {}),
        ...(racedPart1 ? { part1MessageId: racedPart1 } : {}),
      };
      message = await db.message.update({
        where: { id: raced.id },
        data: {
          text: params.text,
          deliveryStatus: "PENDING",
          deliveryError: null,
          ...(Object.keys(racedClaim).length ? { metadata: racedClaim } : {}),
        },
      });
    } else {
      throw new Error("Outbound claim failed without duplicate");
    }
  }
  log.info(
    { messageId: message.id, conversationId: params.conversationId, provider: "facebook" },
    "facebook_outbound_started"
  );

  // 3. Load channel + account + recipient from trusted state.
  // Any unexpected throw below must FAIL the row (never leave PENDING forever —
  // the crash window is what strands the inbox in "sending").
  let conversation: {
    id: string;
    customerId: string;
    lastCustomerMessageAt: Date | null;
    channelConversationId?: string;
    channel: {
      id: string;
      type: string;
      status: string;
      externalId?: string | null;
      account?: { id: string; encryptedCredentials: string; tokenExpiresAt: Date | null } | null;
    } | null;
    customer: unknown;
  };
  try {
    conversation = (await db.conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      include: { channel: { include: { account: true } }, customer: true },
    })) as unknown as typeof conversation;
  } catch (err) {
    await markFailed(db, message.id, "CONVERSATION_NOT_FOUND", "تعذر العثور على المحادثة");
    log.warn(
      { messageId: message.id, conversationId: params.conversationId, status: "FAILED", reason: "CONVERSATION_NOT_FOUND", durationMs: Date.now() - started },
      "facebook.message.failed"
    );
    return { messageId: message.id, deliveryStatus: "FAILED", error: "CONVERSATION_NOT_FOUND", durationMs: Date.now() - started };
  }
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
    provider: providerOf(channel?.type ?? "FACEBOOK"),
  };

  if (!channel || !account || !(OUTBOUND_CHANNELS as readonly string[]).includes(channel.type)) {
    await markFailed(db, message.id, "CHANNEL_NOT_CONFIGURED", "القناة غير مربوطة");
    log.warn({ ...ctx, status: "FAILED", reason: "CHANNEL_NOT_CONFIGURED", durationMs: Date.now() - started }, "facebook.message.failed");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "CHANNEL_NOT_CONFIGURED", channelId: ctx.channelId, pageId: ctx.pageId, durationMs: Date.now() - started };
  }

  // 4. Messaging policy (per channel; Messenger behavior below is verbatim).
  // Non-Facebook policy runs inside dispatchChannelSend AFTER token decrypt
  // (it needs token validity) — still before any send. Same guarantee.
  if (channel.type === "FACEBOOK") {
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
  }

  // 5. Recipient from ChannelIdentity (trusted), scoped to this conversation's
  // account via channelConversationId — never AI output, never another account.
  const conversationPsid = (conversation as { channelConversationId?: string }).channelConversationId;
  let identity = conversationPsid
    ? await db.channelIdentity.findFirst({
        where: {
          workspaceId: params.workspaceId,
          customerId: conversation.customerId,
          channelType: channel.type as ChannelType,
          channelExternalId: conversationPsid,
        },
        select: { channelExternalId: true },
      })
    : null;
  identity ??= await db.channelIdentity.findFirst({
    where: { workspaceId: params.workspaceId, customerId: conversation.customerId, channelType: channel.type as ChannelType },
    select: { channelExternalId: true },
  });
  if (!identity) {
    await markFailed(db, message.id, "RECIPIENT_NOT_FOUND", "تعذر العثور على المستلم");
    log.warn({ ...ctx, status: "FAILED", reason: "RECIPIENT_NOT_FOUND", durationMs: Date.now() - started }, "facebook.message.failed");
    return { messageId: message.id, deliveryStatus: "FAILED", error: "RECIPIENT_NOT_FOUND", channelId: ctx.channelId, pageId: ctx.pageId, durationMs: Date.now() - started };
  }
  const recipientId = identity.channelExternalId;

  // 6. Prepare media attachment (if any) via signed public URL.
  // A missing/inaccessible asset must FAIL fast (never strand PENDING).
  // NOTE: Meta's Send API accepts text XOR attachment per message, so a reply
  // carrying both is delivered as TWO ordered Graph sends (attachment first,
  // then text) under this single idempotency row — never a silent drop of
  // either part. Partial progress (part1MessageId) is persisted so a crash
  // between the two sends never duplicates the first part on recovery.
  let attachment: { type: "image" | "video" | "audio" | "file"; payload: { url: string } } | null = null;
  if (params.mediaId) {
    try {
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
      attachment = { type: attachType, payload: { url: publicUrl } };
    } catch (err) {
      await markFailed(db, message.id, "MEDIA_NOT_AVAILABLE", "تعذر إرفاق الوسائط");
      log.warn({ ...ctx, recipientId, status: "FAILED", reason: "MEDIA_NOT_AVAILABLE", durationMs: Date.now() - started }, "facebook.message.failed");
      return { messageId: message.id, deliveryStatus: "FAILED", error: "MEDIA_NOT_AVAILABLE", channelId: ctx.channelId, pageId: ctx.pageId, recipientId, durationMs: Date.now() - started };
    }
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

  // Prior partial progress for this row (crash between the two sends).
  const rowMeta = await db.message
    .findUnique({ where: { id: message.id }, select: { metadata: true } })
    .catch(() => null);
  const priorPart1 =
    rowMeta && typeof (rowMeta.metadata as { part1MessageId?: unknown })?.part1MessageId === "string"
      ? ((rowMeta.metadata as { part1MessageId: string }).part1MessageId)
      : null;

  const persistPart1 = async (part1MessageId: string) => {
    await persistPart1For(db, message.id, params.mediaId ?? undefined, part1MessageId);
  };

  // 7b. Non-Messenger transports share the idempotency shell above and the
  // persist/error shapes below; only policy + sender differ per provider.
  if (channel.type !== "FACEBOOK") {
    return dispatchChannelSend(db, {
      params,
      messageId: message.id,
      channel,
      account,
      conversation: {
        lastCustomerMessageAt: conversation.lastCustomerMessageAt,
      },
      recipientId,
      attachment,
      priorPart1,
      started,
      channelId: ctx.channelId,
      pageId: ctx.pageId,
    });
  }

  try {
    // Dual-send when both parts exist; single-send otherwise.
    // P1.1: Graph sends go through the registry-resolved real adapter. The
    // bound sender IS the existing client call (same token, same recipient,
    // same payloads, same error classification) — idempotency, policy,
    // ordering, retry accounting and recovery above/below are untouched.
    const adapter = getChannelAdapter("FACEBOOK", {
      facebook: {
        pageId: channel.externalId ?? undefined,
        channelAccountId: account.id,
        sender: async (recipient, payload) => {
          if (payload.attachment) {
            const r = await client.sendMessage(pageAccessToken, recipient, {
              attachment: { type: payload.attachment.type, payload: { url: payload.attachment.url } },
            });
            return { messageId: r.messageId, graphCode: r.graphCode };
          }
          const r = await client.sendMessage(pageAccessToken, recipient, { text: payload.text });
          return { messageId: r.messageId, graphCode: r.graphCode };
        },
      },
    });
    if (!(adapter instanceof FacebookChannelAdapter)) {
      throw new ChannelNotSupportedError("FACEBOOK");
    }
    const graphCodeOf = (r: { raw?: Record<string, unknown> }): string | undefined =>
      typeof r.raw?.graphCode === "string" ? (r.raw.graphCode as string) : undefined;
    const toMessageType = (t: "image" | "video" | "audio" | "file"): "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" =>
      t === "image" ? "IMAGE" : t === "video" ? "VIDEO" : t === "audio" ? "AUDIO" : "DOCUMENT";
    let firstMid: string | undefined;
    let secondMid: string | undefined;
    let graphCode: string | undefined;
    if (attachment && params.text?.trim()) {
      if (priorPart1) {
        firstMid = priorPart1;
      } else {
        const r1 = await adapter.sendMedia(recipientId, { type: toMessageType(attachment.type), mediaUrl: attachment.payload.url });
        firstMid = r1.externalMessageId;
        graphCode = graphCodeOf(r1);
        await persistPart1(firstMid);
      }
      const r2 = await adapter.sendText(recipientId, params.text);
      secondMid = r2.externalMessageId;
      graphCode = graphCodeOf(r2) ?? graphCode;
    } else {
      const single = attachment
        ? await adapter.sendMedia(recipientId, { type: toMessageType(attachment.type), mediaUrl: attachment.payload.url })
        : await adapter.sendText(recipientId, params.text);
      firstMid = single.externalMessageId;
      graphCode = graphCodeOf(single);
    }
    await db.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: "SENT",
        externalMessageId: firstMid,
        deliveryError: null,
        ...(secondMid ? { metadata: { ...(params.mediaId ? { mediaId: params.mediaId } : {}), ...(priorPart1 || attachment ? { part1MessageId: firstMid } : {}), secondExternalMessageId: secondMid } } : {}),
      },
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
    log.info({ ...ctx, recipientId, status: "SENT", graphCode, parts: secondMid ? 2 : 1, durationMs: Date.now() - started }, "facebook.message.sent");
    return { messageId: message.id, deliveryStatus: "SENT", externalMessageId: firstMid, graphCode, channelId: ctx.channelId, pageId: ctx.pageId, recipientId, durationMs: Date.now() - started };
  } catch (err) {
    const isTransient = err instanceof FacebookApiError && err.kind === ("TRANSIENT" as const);
    const code = err instanceof FacebookApiError ? `${err.code ?? ""}/${err.subcode ?? ""}` : "";
    const httpStatus = err instanceof FacebookApiError ? err.httpStatus : undefined;
    // Increment retryCount from the row's own metadata (never reset to 1), so
    // exhausted retries are observable and recovery can reason about them.
    // Preserve mediaId + part1MessageId so recovery resumes (never duplicates).
    let prevRetryCount = 0;
    let keepPart1: string | null = priorPart1;
    try {
      const row = await db.message.findUnique({ where: { id: message.id }, select: { metadata: true } });
      const meta = (row?.metadata ?? {}) as { retryCount?: unknown; part1MessageId?: unknown };
      prevRetryCount = typeof meta.retryCount === "number" ? meta.retryCount : 0;
      if (typeof meta.part1MessageId === "string") keepPart1 = meta.part1MessageId;
    } catch {
      prevRetryCount = 0;
    }
    await db.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: isTransient ? "QUEUED" : "FAILED",
        deliveryError: err instanceof Error ? err.message : String(err),
        metadata: {
          ...(params.mediaId ? { mediaId: params.mediaId } : {}),
          ...(keepPart1 ? { part1MessageId: keepPart1 } : {}),
          providerErrorCode: code || "UNKNOWN",
          providerErrorMessage: err instanceof Error ? err.message : String(err),
          failedAt: new Date().toISOString(),
          retryable: isTransient,
          retryCount: prevRetryCount + 1,
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

/** Shared part-1 persistence for dual sends (Messenger + generic transports). */
async function persistPart1For(
  db: Db,
  messageId: string,
  mediaId: string | null | undefined,
  part1MessageId: string
): Promise<void> {
  const cur = await db.message
    .findUnique({ where: { id: messageId }, select: { metadata: true } })
    .catch(() => null);
  await db.message.update({
    where: { id: messageId },
    data: {
      metadata: {
        ...((cur?.metadata ?? {}) as Record<string, unknown>),
        ...(mediaId ? { mediaId } : {}),
        part1MessageId,
      },
    },
  });
}

interface ChannelSendContext {
  params: DispatchOutboundParams;
  messageId: string;
  channel: { id: string; type: string; status: string; externalId?: string | null };
  account: { id: string; encryptedCredentials: string; tokenExpiresAt?: Date | string | null; metadata?: Record<string, unknown> | null };
  conversation: { lastCustomerMessageAt?: Date | string | null };
  recipientId: string;
  attachment: { type: "image" | "video" | "audio" | "file"; payload: { url: string } } | null;
  priorPart1: string | null;
  started: number;
  channelId?: string;
  pageId?: string;
}

/**
 * Generic multi-channel send (P5): policy → registry-resolved adapter →
 * persist, mirroring the Messenger guarantees (single idempotency row,
 * part-1 resume, transient QUEUED / permanent FAILED, retry accounting).
 * Provider error classes keep their TRANSIENT/PERMANENT kinds.
 */
async function dispatchChannelSend(db: Db, s: ChannelSendContext): Promise<DispatchOutboundResult> {
  const scope = `${providerOf(s.channel.type)}.message`;
  const base = { messageId: s.messageId, conversationId: s.params.conversationId, channelId: s.channelId, pageId: s.pageId } as const;

  let token: string;
  try {
    token = decryptSecret(s.account.encryptedCredentials);
  } catch {
    await markFailed(db, s.messageId, "TOKEN_DECRYPT_FAILED", "تعذر الاتصال بالقناة");
    log.warn({ ...base, recipientId: s.recipientId, status: "FAILED", reason: "TOKEN_DECRYPT_FAILED", durationMs: Date.now() - s.started }, `${scope}.failed`);
    return { messageId: s.messageId, deliveryStatus: "FAILED", error: "TOKEN_DECRYPT_FAILED", channelId: s.channelId, pageId: s.pageId, recipientId: s.recipientId, durationMs: Date.now() - s.started };
  }

  const verdict = checkChannelPolicy(s.channel.type, {
    channelStatus: s.channel.status,
    tokenExpiresAt: s.account.tokenExpiresAt ?? undefined,
    lastCustomerMessageAt: s.conversation.lastCustomerMessageAt ?? undefined,
    tokenValid: true,
    tiktokApproved: (s.account.metadata as { ttAccessApproved?: boolean } | null | undefined)?.ttAccessApproved ?? false,
    // القالب يمر للسياسة: خارج نافذة واتساب، القالب المعتمد هو المسار المسموح
    template: s.params.template ?? null,
  });
  if (!verdict.allowed) {
    await markFailed(db, s.messageId, `POLICY_${verdict.reason}`, "تعذر الإرسال حسب سياسة المنصة");
    log.warn({ ...base, recipientId: s.recipientId, status: "FAILED", reason: `POLICY_${verdict.reason}`, durationMs: Date.now() - s.started }, `${scope}.failed`);
    return { messageId: s.messageId, deliveryStatus: "FAILED", error: `POLICY_${verdict.reason}`, channelId: s.channelId, pageId: s.pageId, recipientId: s.recipientId, durationMs: Date.now() - s.started };
  }

  const adapter = resolveChannelSender(s.channel.type, {
    channelAccountId: s.account.id,
    channelId: s.channel.id,
    externalId: s.channel.externalId,
    token,
    recipientId: s.recipientId,
  });

  const codeOf = (r: { raw?: Record<string, unknown> }): string | undefined =>
    typeof r.raw?.graphCode === "string"
      ? (r.raw.graphCode as string)
      : typeof r.raw?.code === "string"
        ? (r.raw.code as string)
        : undefined;
  const toMessageType = (t: "image" | "video" | "audio" | "file"): "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" =>
    t === "image" ? "IMAGE" : t === "video" ? "VIDEO" : t === "audio" ? "AUDIO" : "DOCUMENT";

  try {
    let firstMid: string | undefined;
    let secondMid: string | undefined;
    let code: string | undefined;
    if (s.params.template && s.channel.type === "WHATSAPP") {
      // P9 — مسار القالب المعتمد (WhatsApp Business Platform) فقط.
      if (s.attachment) throw new AppError("لا يجوز دمج الوسائط مع القالب", 422, "TEMPLATE_MEDIA_UNSUPPORTED");
      const tplAdapter = adapter as unknown as {
        sendTemplateMessage?: (ref: string, t: { name: string; language: string; variables?: Record<string, string> }) => Promise<{ externalMessageId: string; raw?: Record<string, unknown> }>;
      };
      if (typeof tplAdapter.sendTemplateMessage !== "function") {
        throw new AppError("القناة لا تدعم إرسال القوالب", 501, "CHANNEL_FEATURE_UNSUPPORTED");
      }
      const single = await tplAdapter.sendTemplateMessage(s.recipientId, s.params.template);
      firstMid = single.externalMessageId;
      code = codeOf(single);
    } else if (s.params.template) {
      throw new AppError("القناة لا تدعم إرسال القوالب", 501, "CHANNEL_FEATURE_UNSUPPORTED");
    } else if (s.attachment && s.params.text?.trim()) {
      if (s.priorPart1) {
        firstMid = s.priorPart1;
      } else {
        const r1 = await adapter.sendMedia(s.recipientId, { type: toMessageType(s.attachment.type), mediaUrl: s.attachment.payload.url });
        firstMid = r1.externalMessageId;
        code = codeOf(r1);
        await persistPart1For(db, s.messageId, s.params.mediaId ?? undefined, firstMid);
      }
      const r2 = await adapter.sendText(s.recipientId, s.params.text);
      secondMid = r2.externalMessageId;
      code = codeOf(r2) ?? code;
    } else {
      const single = s.attachment
        ? await adapter.sendMedia(s.recipientId, { type: toMessageType(s.attachment.type), mediaUrl: s.attachment.payload.url })
        : await adapter.sendText(s.recipientId, s.params.text);
      firstMid = single.externalMessageId;
      code = codeOf(single);
    }
    await db.message.update({
      where: { id: s.messageId },
      data: {
        deliveryStatus: "SENT",
        externalMessageId: firstMid,
        deliveryError: null,
        provider: providerOf(s.channel.type),
        ...(secondMid ? { metadata: { ...(s.params.mediaId ? { mediaId: s.params.mediaId } : {}), ...(s.priorPart1 || s.attachment ? { part1MessageId: firstMid } : {}), secondExternalMessageId: secondMid } } : {}),
      },
    });
    await db.channelAccount.update({
      where: { id: s.account.id },
      data: { lastSendAt: new Date() },
    });
    await db.conversation.update({
      where: { id: s.params.conversationId },
      data: { lastAgentMessageAt: new Date() },
    });
    try {
      const { incrementUsage } = await import("@/core/analytics/usage-service");
      await incrementUsage(db as never, s.params.workspaceId, { messagesOutbound: 1 });
    } catch {
      // never break sending
    }
    log.info({ ...base, recipientId: s.recipientId, status: "SENT", graphCode: code, parts: secondMid ? 2 : 1, durationMs: Date.now() - s.started }, `${scope}.sent`);
    return { messageId: s.messageId, deliveryStatus: "SENT", externalMessageId: firstMid, graphCode: code, channelId: s.channelId, pageId: s.pageId, recipientId: s.recipientId, durationMs: Date.now() - s.started };
  } catch (err) {
    const transient =
      (err instanceof TelegramApiError ||
        err instanceof WhatsAppApiError ||
        err instanceof InstagramApiError ||
        err instanceof TikTokApiError) &&
      err.kind === "TRANSIENT";
    const code =
      err instanceof TelegramApiError || err instanceof WhatsAppApiError || err instanceof InstagramApiError || err instanceof TikTokApiError
        ? `${err.code ?? ""}`
        : "";
    const httpStatus =
      err instanceof WhatsAppApiError || err instanceof InstagramApiError ? err.httpStatus : undefined;
    let prevRetryCount = 0;
    let keepPart1: string | null = s.priorPart1;
    try {
      const row = await db.message.findUnique({ where: { id: s.messageId }, select: { metadata: true } });
      const meta = (row?.metadata ?? {}) as { retryCount?: unknown; part1MessageId?: unknown };
      prevRetryCount = typeof meta.retryCount === "number" ? meta.retryCount : 0;
      if (typeof meta.part1MessageId === "string") keepPart1 = meta.part1MessageId;
    } catch {
      prevRetryCount = 0;
    }
    await db.message.update({
      where: { id: s.messageId },
      data: {
        deliveryStatus: transient ? "QUEUED" : "FAILED",
        deliveryError: err instanceof Error ? err.message : String(err),
        metadata: {
          ...(s.params.mediaId ? { mediaId: s.params.mediaId } : {}),
          ...(keepPart1 ? { part1MessageId: keepPart1 } : {}),
          providerErrorCode: code || "UNKNOWN",
          providerErrorMessage: err instanceof Error ? err.message : String(err),
          failedAt: new Date().toISOString(),
          retryable: transient,
          retryCount: prevRetryCount + 1,
        },
      },
    });
    log.warn({ ...base, recipientId: s.recipientId, status: transient ? "QUEUED" : "FAILED", graphCode: code, httpStatus, durationMs: Date.now() - s.started }, `${scope}.failed`);
    return {
      messageId: s.messageId,
      deliveryStatus: transient ? "QUEUED" : "FAILED",
      error: err instanceof Error ? err.message : String(err),
      graphCode: code || undefined,
      channelId: s.channelId,
      pageId: s.pageId,
      recipientId: s.recipientId,
      durationMs: Date.now() - s.started,
    };
  }
}

/**
 * Binds a registry adapter to live credentials for one send. Tokens never
 * enter the adapter except through this closure (same boundary as P1.1).
 */
function resolveChannelSender(
  channelType: string,
  ctx: { channelAccountId: string; channelId: string; externalId?: string | null; token: string; recipientId: string }
): { sendText: (ref: string, text: string) => Promise<{ externalMessageId: string; raw?: Record<string, unknown> }>; sendMedia: (ref: string, m: { type: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT"; mediaUrl: string }) => Promise<{ externalMessageId: string; raw?: Record<string, unknown> }> } {
  switch (channelType) {
    case "INSTAGRAM": {
      const client = getInstagramClient();
      const sender = async (to: string, p: { text?: string; attachment?: { type: string; url: string } }) => {
        const r = p.attachment
          ? await client.sendMessage(ctx.token, to, { attachment: { type: p.attachment.type, payload: { url: p.attachment.url } } })
          : await client.sendMessage(ctx.token, to, { text: p.text });
        return { messageId: r.messageId };
      };
      const adapter = getChannelAdapter("INSTAGRAM", {
        instagram: { channelAccountId: ctx.channelAccountId, channelId: ctx.channelId, sender },
      });
      if (!(adapter instanceof InstagramChannelAdapter)) throw new ChannelNotSupportedError("INSTAGRAM");
      return adapter;
    }
    case "TELEGRAM": {
      const client = getTelegramClient();
      const sender = async (to: string, p: { text?: string; photoUrl?: string; documentUrl?: string; caption?: string }) => {
        if (p.photoUrl || p.documentUrl) {
          const r = await client.sendMessage(ctx.token, to, p.photoUrl ? { photo: p.photoUrl, caption: p.caption } : { document: p.documentUrl!, caption: p.caption });
          return { messageId: String(r.messageId) };
        }
        const r = await client.sendMessage(ctx.token, to, { text: p.text });
        return { messageId: String(r.messageId) };
      };
      const adapter = getChannelAdapter("TELEGRAM", {
        telegram: { channelAccountId: ctx.channelAccountId, channelId: ctx.channelId, sender },
      });
      if (!(adapter instanceof TelegramChannelAdapter)) throw new ChannelNotSupportedError("TELEGRAM");
      return adapter;
    }
    case "WHATSAPP": {
      if (!ctx.externalId) {
        throw new AppError("WhatsApp number id missing on channel", 422, "CHANNEL_NOT_CONFIGURED");
      }
      const phoneNumberId = ctx.externalId;
      const client = getWhatsAppClient();
      const sender = async (to: string, p: { text?: string; media?: { kind: "image" | "video" | "audio" | "document"; url: string; caption?: string }; template?: { name: string; language: string; variables?: Record<string, string> } }) => {
        if (p.template) {
          const r = await client.sendTemplate(ctx.token, phoneNumberId, to, p.template);
          return { messageId: r.messageId };
        }
        const r = p.media
          ? await client.sendMedia(ctx.token, phoneNumberId, to, p.media.kind, p.media.url, p.media.caption)
          : await client.sendText(ctx.token, phoneNumberId, to, p.text ?? "");
        return { messageId: r.messageId };
      };
      const adapter = getChannelAdapter("WHATSAPP", {
        whatsapp: { phoneNumberId, channelAccountId: ctx.channelAccountId, channelId: ctx.channelId, sender },
      });
      if (!(adapter instanceof WhatsAppChannelAdapter)) throw new ChannelNotSupportedError("WHATSAPP");
      return adapter;
    }
    case "TIKTOK": {
      const client = getTikTokClient();
      const sender = async (to: string, text: string) => {
        const r = await client.sendDirectMessage(ctx.token, to, text);
        return { messageId: r.messageId };
      };
      const adapter = getChannelAdapter("TIKTOK", {
        tiktok: { channelAccountId: ctx.channelAccountId, channelId: ctx.channelId, sender },
      });
      if (!(adapter instanceof TikTokChannelAdapter)) throw new ChannelNotSupportedError("TIKTOK");
      return adapter;
    }
    default:
      throw new ChannelNotSupportedError(channelType);
  }
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
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      conversationId: true,
      workspaceId: true,
      text: true,
      senderType: true,
      senderId: true,
      outboundIdempotencyKey: true,
      deliveryStatus: true,
      metadata: true,
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
      const meta = (msg.metadata ?? {}) as { mediaId?: unknown };
      const mediaId = typeof meta.mediaId === "string" ? meta.mediaId : undefined;
      const result = await dispatchOutbound(db, {
        workspaceId: msg.workspaceId,
        conversationId: msg.conversationId,
        sourceMessageId,
        text: msg.text ?? "",
        senderType: msg.senderType === "HUMAN" ? "HUMAN" : "AI",
        senderId: msg.senderId ?? undefined,
        ...(mediaId ? { mediaId } : {}),
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
