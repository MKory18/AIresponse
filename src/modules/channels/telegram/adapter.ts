import type { ChannelType } from "@prisma/client";
import { ChannelNotSupportedError } from "../types";
import type {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutboundMessage,
} from "../types";
import { normalizeTelegramUpdate } from "./normalizer";

export interface TelegramAdapterContext {
  /** Bot username (external account id) for routing clarity. */
  botUsername?: string;
  channelAccountId: string;
  /** Exact internal channel row (set by the webhook router). */
  channelId?: string;
  /** Bound sender owning the bot token. */
  sender?: (
    chatId: string,
    payload: { text?: string; photoUrl?: string; documentUrl?: string; caption?: string }
  ) => Promise<{ messageId: number | string; code?: string }>;
}

/** Telegram Bot API adapter (P5-C). Media travels by URL (no file proxying). */
export class TelegramChannelAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = "TELEGRAM";
  readonly provider = "telegram";

  constructor(private readonly ctx: TelegramAdapterContext) {
    if (!ctx.channelAccountId) {
      throw new ChannelNotSupportedError("TELEGRAM (missing channel account binding)");
    }
  }

  private requireSender() {
    if (typeof this.ctx.sender !== "function") {
      throw new ChannelNotSupportedError("TELEGRAM (sender not bound — receive-only adapter)");
    }
    return this.ctx.sender;
  }

  receiveMessage(payload: unknown): NormalizedIncomingMessage[] {
    const m = normalizeTelegramUpdate(payload as Parameters<typeof normalizeTelegramUpdate>[0]);
    if (!m) return [];
    return [
      {
        channelType: "TELEGRAM" as ChannelType,
        externalUserId: m.externalCustomerId,
        externalUserName: m.senderName,
        externalConversationId: m.externalConversationId,
        externalMessageId: m.externalMessageId,
        externalEventId: m.externalEventId,
        provider: this.provider,
        type: (m.mediaType === "TEXT" ? "TEXT" : m.mediaType === "IMAGE" ? "IMAGE" : "DOCUMENT") as NormalizedIncomingMessage["type"],
        text: m.text,
        // file_id references require a getFile round-trip; out of P5 scope —
        // mediaUrl stays null and the caption/text carries the content.
        mediaUrl: null,
        metadata: { updateId: m.updateId, mediaFileId: m.mediaFileId ?? null },
        sentAt: m.timestamp,
        channelId: this.ctx.channelId,
      },
    ];
  }

  async sendText(conversationRef: string, text: string): Promise<ChannelSendResult> {
    const res = await this.requireSender()(conversationRef, { text });
    return { externalMessageId: `tg:${String(res.messageId)}`, provider: this.provider, raw: { code: res.code } };
  }

  async sendMedia(conversationRef: string, message: OutboundMessage): Promise<ChannelSendResult> {
    const url = message.mediaUrl ?? "";
    const kind = message.type === "IMAGE" ? "photoUrl" : "documentUrl";
    const res = await this.requireSender()(conversationRef, { [kind]: url, caption: message.text });
    return { externalMessageId: `tg:${String(res.messageId)}`, provider: this.provider, raw: { code: res.code } };
  }

  async markRead(): Promise<void> {
    // Bots have no read-receipt API (see capabilities).
  }
}
