import type { ChannelType } from "@prisma/client";
import { ChannelNotSupportedError } from "../types";
import type {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutboundMessage,
} from "../types";
import { deriveInstagramEventId, normalizeInstagramWebhook } from "./normalizer";

export interface InstagramAdapterContext {
  /** Instagram professional account id (IGID). */
  igId?: string;
  channelAccountId: string;
  /** Exact internal channel row (set by the webhook router). */
  channelId?: string;
  /** Bound sender owning the page access token. */
  sender?: (
    recipientId: string,
    payload: { text?: string; attachment?: { type: string; url: string } }
  ) => Promise<{ messageId: string; code?: string }>;
}

/**
 * Instagram Messaging adapter (P5-B). Same Graph family as Messenger:
 * normalization mirrors the Messenger shapes with IGSID/IGID ids.
 */
export class InstagramChannelAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = "INSTAGRAM";
  readonly provider = "instagram";

  constructor(private readonly ctx: InstagramAdapterContext) {
    if (!ctx.channelAccountId) {
      throw new ChannelNotSupportedError("INSTAGRAM (missing channel account binding)");
    }
  }

  private requireSender() {
    if (typeof this.ctx.sender !== "function") {
      throw new ChannelNotSupportedError("INSTAGRAM (sender not bound — receive-only adapter)");
    }
    return this.ctx.sender;
  }

  receiveMessage(payload: unknown): NormalizedIncomingMessage[] {
    const rawEventId = deriveInstagramEventId(payload);
    return normalizeInstagramWebhook(payload as Parameters<typeof normalizeInstagramWebhook>[0], rawEventId).map(
      (m) => ({
        channelType: "INSTAGRAM" as ChannelType,
        externalUserId: m.externalCustomerId,        externalUserName: null,
        externalConversationId: m.externalConversationId,
        externalMessageId: m.externalMessageId,
        externalEventId: m.externalEventId,
        provider: this.provider,
        type: (m.mediaType === "TEXT" ? "TEXT" : m.mediaType === "FILE" ? "DOCUMENT" : m.mediaType) as NormalizedIncomingMessage["type"],
        text: m.text,
        mediaUrl: m.mediaUrl,
        metadata: { rawEventId: m.rawEventId },
        sentAt: m.timestamp,
        channelId: this.ctx.channelId,
      })
    );
  }

  async sendText(conversationRef: string, text: string): Promise<ChannelSendResult> {
    const res = await this.requireSender()(conversationRef, { text });
    return { externalMessageId: res.messageId, provider: this.provider, raw: { code: res.code } };
  }

  async sendMedia(conversationRef: string, message: OutboundMessage): Promise<ChannelSendResult> {
    const kind =
      message.type === "IMAGE" ? "image"
      : message.type === "VIDEO" ? "video"
      : message.type === "AUDIO" ? "audio"
      : "file";
    const res = await this.requireSender()(conversationRef, {
      attachment: { type: kind, url: message.mediaUrl ?? "" },
    });
    return { externalMessageId: res.messageId, provider: this.provider, raw: { code: res.code } };
  }

  async markRead(): Promise<void> {
    // No read-receipt support in this adapter (see capabilities).
  }
}
