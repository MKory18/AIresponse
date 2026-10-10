/**
 * Channel abstraction (P5: multi-channel). Every provider implements the
 * same interface; the platform never talks to a channel SDK directly.
 * Capabilities are EXPLICIT per channel — requesting an unsupported feature
 * throws instead of faking success.
 */
import type { ChannelType, MessageType } from "@prisma/client";
import { AppError } from "@/core/errors";

export interface NormalizedIncomingMessage {
  channelType: ChannelType;
  /** External user id on that channel (page-scoped, phone, chat id…). */
  externalUserId: string;
  externalUserName?: string | null;
  externalConversationId: string;
  externalMessageId: string;
  externalEventId: string;
  provider: string;
  type: MessageType;
  text?: string | null;
  mediaUrl?: string | null;
  metadata?: Record<string, unknown>;
  sentAt?: Date;
  /** P5: exact internal channel row (when the router resolved it). */
  channelId?: string;
}

export interface OutboundMessage {
  type: MessageType;
  text?: string;
  mediaUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelSendResult {
  externalMessageId: string;
  provider: string;
  raw?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channelType: ChannelType;
  readonly provider: string;
  /** Normalize a provider webhook payload into NormalizedIncomingMessage[]. */
  receiveMessage(payload: unknown): NormalizedIncomingMessage[];
  sendText(conversationRef: string, text: string): Promise<ChannelSendResult>;
  sendMedia(conversationRef: string, message: OutboundMessage): Promise<ChannelSendResult>;
  markRead(conversationRef: string, externalMessageId: string): Promise<void>;
}

/** Fail-closed: a channel without a registered real adapter is never mocked. */
export class ChannelNotSupportedError extends AppError {
  constructor(channelType: string) {
    super(`No production adapter registered for channel "${channelType}"`, 501, "CHANNEL_NOT_SUPPORTED");
  }
}

/** Fail-closed: the feature is not supported on this channel. Never faked. */
export class ChannelFeatureError extends AppError {
  constructor(channelType: string, feature: string) {
    super(`Channel "${channelType}" does not support "${feature}"`, 501, "CHANNEL_FEATURE_UNSUPPORTED");
  }
}

/**
 * Explicit capability matrix. Values describe what OUR adapter implements
 * through the provider's official API — never aspirational. Anything false
 * throws ChannelFeatureError when requested.
 */
export interface ChannelCapabilities {
  supportsText: boolean;
  supportsMedia: boolean;
  /** Media kinds the adapter can send (subset of provider abilities). */
  mediaKinds: Array<"image" | "video" | "audio" | "file">;
  supportsComments: boolean;
  /** One private reply per comment within the provider window. */
  supportsPrivateCommentReply: boolean;
  supportsReadReceipts: boolean;
  supportsTemplates: boolean;
}

export const CHANNEL_CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
  FACEBOOK: {
    supportsText: true,
    supportsMedia: true,
    mediaKinds: ["image", "video", "audio", "file"],
    supportsComments: true,
    supportsPrivateCommentReply: true,
    supportsReadReceipts: false,
    supportsTemplates: false,
  },
  INSTAGRAM: {
    supportsText: true,
    supportsMedia: true,
    mediaKinds: ["image", "video", "audio", "file"],
    supportsComments: true,
    supportsPrivateCommentReply: true,
    supportsReadReceipts: false,
    supportsTemplates: false,
  },
  TELEGRAM: {
    supportsText: true,
    supportsMedia: true,
    mediaKinds: ["image", "video", "audio", "file"],
    supportsComments: false,
    supportsPrivateCommentReply: false,
    supportsReadReceipts: false,
    supportsTemplates: false,
  },
  WHATSAPP: {
    supportsText: true,
    supportsMedia: true,
    mediaKinds: ["image", "video", "audio", "file"],
    supportsComments: false,
    supportsPrivateCommentReply: false,
    supportsReadReceipts: false,
    // Templates exist on the platform but sending them is not implemented in
    // P5 — outside-window sends refuse with a clear policy error instead.
    supportsTemplates: false,
  },
  WEB: {
    supportsText: false,
    supportsMedia: false,
    mediaKinds: [],
    supportsComments: false,
    supportsPrivateCommentReply: false,
    supportsReadReceipts: false,
    supportsTemplates: false,
  },
  TIKTOK: {
    // Local-only shape (P5-E): text mapping per the public Business
    // Messaging payload shape; media/comments unverified → disabled.
    supportsText: true,
    supportsMedia: false,
    mediaKinds: [],
    supportsComments: false,
    supportsPrivateCommentReply: false,
    supportsReadReceipts: false,
    supportsTemplates: false,
  },
};

/** Per-provider send policy verdict (checked before every send). */
export interface ChannelPolicyDecision {
  allowed: boolean;
  /** Machine reason (POLICY_*), surfaced in delivery metadata. */
  reason?: string;
  /** True when only an approved template may go out (e.g. WhatsApp). */
  requiresTemplate?: boolean;
}

/** Provider comment (feed/comments webhooks) — channel-native shape. */
export interface ChannelComment {
  commentId: string;
  postId?: string | null;
  text?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  createdAt?: Date | null;
  hidden?: boolean;
}

/**
 * Outbound transport behind dispatchOutbound's shared idempotency/claim/
 * recovery shell. Messenger keeps its dual-send; other providers send in
 * whatever shape their official API supports. Errors keep provider
 * TRANSIENT/PERMANENT classification so retry policy stays sane.
 */
export interface ChannelTransport {
  send(payload: {
    text?: string;
    attachment?: { type: "image" | "video" | "audio" | "file"; url: string };
  }): Promise<{ messageIds: string[]; code?: string }>;
}
