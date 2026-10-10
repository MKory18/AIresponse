import type { ChannelType } from "@prisma/client";
import { ChannelFeatureError, ChannelNotSupportedError } from "../types";
import type {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutboundMessage,
} from "../types";
import { normalizeTikTokEvent, type AssumedTikTokEvent } from "./normalizer";

export interface TikTokAdapterContext {
  channelAccountId: string;
  /** Exact internal channel row (set by the webhook router). */
  channelId?: string;
  sender?: (
    conversationId: string,
    text: string
  ) => Promise<{ messageId: string; code?: string }>;
}

/** TikTok Business Messaging adapter (P5-E — LOCAL ONLY, see normalizer). */
export class TikTokChannelAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = "TIKTOK";
  readonly provider = "tiktok";

  constructor(private readonly ctx: TikTokAdapterContext) {
    if (!ctx.channelAccountId) {
      throw new ChannelNotSupportedError("TIKTOK (missing channel account binding)");
    }
  }

  private requireSender() {
    if (typeof this.ctx.sender !== "function") {
      throw new ChannelNotSupportedError("TIKTOK (sender not bound — receive-only adapter)");
    }
    return this.ctx.sender;
  }

  receiveMessage(payload: unknown): NormalizedIncomingMessage[] {
    const m = normalizeTikTokEvent(payload as AssumedTikTokEvent);
    if (!m) return [];
    return [
      {
        channelType: "TIKTOK" as ChannelType,
        externalUserId: m.externalCustomerId,
        externalUserName: m.senderName,
        externalConversationId: m.externalConversationId,
        externalMessageId: m.externalMessageId,
        externalEventId: m.externalEventId,
        provider: this.provider,
        type: "TEXT",
        text: m.text,
        mediaUrl: null,
        metadata: {},
        sentAt: m.timestamp,
        channelId: this.ctx.channelId,
      },
    ];
  }

  async sendText(conversationRef: string, text: string): Promise<ChannelSendResult> {
    const res = await this.requireSender()(conversationRef, text);
    return { externalMessageId: res.messageId, provider: this.provider, raw: { code: res.code } };
  }

  async sendMedia(): Promise<ChannelSendResult> {
    // Media sending is unverified for our access level — explicit refusal.
    throw new ChannelFeatureError("TIKTOK", "sendMedia");
  }

  async markRead(): Promise<void> {
    // No read-receipt support in this adapter (see capabilities).
  }
}
