import type { ChannelType } from "@prisma/client";
import { ChannelNotSupportedError } from "../types";
import type {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutboundMessage,
} from "../types";
import { deriveWhatsAppEventId, normalizeWhatsAppWebhook } from "./normalizer";

export interface WhatsAppAdapterContext {
  /** Business phone number id (external account id). */
  phoneNumberId?: string;
  channelAccountId: string;
  /** Exact internal channel row (set by the webhook router). */
  channelId?: string;
  /** Bound sender owning the system-user token. */
  sender?: (
    to: string,
    payload: {
      text?: string;
      media?: { kind: "image" | "video" | "audio" | "document"; url: string; caption?: string };
      /** P9 — قالب معتمد (المسار الرسمي للتسويق خارج نافذة 24h). */
      template?: { name: string; language: string; variables?: Record<string, string> };
    }
  ) => Promise<{ messageId: string; code?: string }>;
}

/** WhatsApp Cloud API adapter (P5-D). Identity is the wa phone id. */
export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = "WHATSAPP";
  readonly provider = "whatsapp";

  constructor(private readonly ctx: WhatsAppAdapterContext) {
    if (!ctx.channelAccountId) {
      throw new ChannelNotSupportedError("WHATSAPP (missing channel account binding)");
    }
  }

  private requireSender() {
    if (typeof this.ctx.sender !== "function") {
      throw new ChannelNotSupportedError("WHATSAPP (sender not bound — receive-only adapter)");
    }
    return this.ctx.sender;
  }

  receiveMessage(payload: unknown): NormalizedIncomingMessage[] {
    const rawEventId = deriveWhatsAppEventId(payload);
    return normalizeWhatsAppWebhook(payload, rawEventId).map((m) => ({
      channelType: "WHATSAPP" as ChannelType,
      externalUserId: m.from,
      externalUserName: null,
      externalConversationId: m.from,
      externalMessageId: m.waMessageId,
      externalEventId: `${rawEventId}:${m.waMessageId}`,
      provider: this.provider,
      type: m.mediaType,
      text: m.text,
      mediaUrl: m.mediaUrl,
      metadata: {
        rawEventId: m.rawEventId,
        phoneNumberId: m.phoneNumberId,
        // P12 — إحالة إعلان واتساب (تُحفظ مشفّرة بلمسة الإسناد، ولا يُحفظ ctwa_clid مع الرسالة).
        ...(m.referral ? { referral: m.referral } : {}),
      },
      sentAt: m.timestamp,
      channelId: this.ctx.channelId,
    }));
  }

  async sendText(conversationRef: string, text: string): Promise<ChannelSendResult> {
    const res = await this.requireSender()(conversationRef, { text });
    return { externalMessageId: res.messageId, provider: this.provider, raw: { code: res.code } };
  }

  /** P9 — إرسال قالب معتمد عبر Cloud API (Official WhatsApp Business Platform). */
  async sendTemplateMessage(
    conversationRef: string,
    template: { name: string; language: string; variables?: Record<string, string> }
  ): Promise<ChannelSendResult> {
    const res = await this.requireSender()(conversationRef, { template });
    return { externalMessageId: res.messageId, provider: this.provider, raw: { code: res.code } };
  }

  async sendMedia(conversationRef: string, message: OutboundMessage): Promise<ChannelSendResult> {
    const kind =
      message.type === "IMAGE" ? "image"
      : message.type === "VIDEO" ? "video"
      : message.type === "AUDIO" ? "audio"
      : "document";
    const res = await this.requireSender()(conversationRef, {
      media: { kind, url: message.mediaUrl ?? "", caption: message.text },
    });
    return { externalMessageId: res.messageId, provider: this.provider, raw: { code: res.code } };
  }

  async markRead(): Promise<void> {
    // Read receipts via statuses webhooks are transport signals only here.
  }
}
