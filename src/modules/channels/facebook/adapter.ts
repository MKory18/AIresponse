import type { ChannelType, MessageType } from "@prisma/client";
import { ChannelNotSupportedError } from "../types";
import type {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutboundMessage,
} from "../types";
import {
  deriveEventId,
  normalizeFacebookWebhook,
  type MetaWebhookPayload,
} from "./normalizer";
import type { NormalizedInboundMessage } from "./types";

export interface FacebookAdapterContext {
  /**
   * Connected Page id. Required for RECEIVING (entry filter); optional for
   * SENDING (the Send API addresses the recipient PSID under the bound page
   * token — a null Channel.externalId must not strand a send).
   */
  pageId?: string;
  /** Internal channel-account row id (join key, never a secret). */
  channelAccountId: string;
  /**
   * Bound sender owning the page token (credentials never enter the
   * adapter — the existing outbound path keeps owning them). Required for
   * SENDING only; receive-only bindings omit it.
   */
  sender?: (
    recipientId: string,
    payload: { text?: string; attachment?: { type: "image" | "video" | "audio" | "file"; url: string } }
  ) => Promise<{ messageId: string; graphCode?: string }>;
}

function messageTypeOf(firstAttachmentType?: string): MessageType {
  switch (firstAttachmentType) {
    case "IMAGE": return "IMAGE";
    case "VIDEO": return "VIDEO";
    case "AUDIO": return "AUDIO";
    case "LOCATION": return "LOCATION";
    case "FILE": return "DOCUMENT";
    default: return "TEXT";
  }
}

/**
 * FacebookChannelAdapter — the real Messenger adapter behind the unified
 * ChannelAdapter interface. Thin protocol mapping over the EXISTING,
 * production-used normalizer; sending delegates to an injected page-token
 * owner. Adds no new Meta behavior.
 *
 * P1.1: also exposes receiveNative() — the SAME normalization in the
 * facebook-native shape — so the live webhook flow resolves through the
 * registry without changing its downstream job contract (P5 migrates
 * downstream to the generic shape).
 */
export class FacebookChannelAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = "FACEBOOK";
  readonly provider = "facebook";

  constructor(private readonly ctx: FacebookAdapterContext) {
    if (!ctx.channelAccountId) {
      throw new ChannelNotSupportedError("FACEBOOK (missing channel account binding)");
    }
  }

  private requireSender() {
    if (typeof this.ctx.sender !== "function") {
      throw new ChannelNotSupportedError("FACEBOOK (sender not bound — receive-only adapter)");
    }
    return this.ctx.sender;
  }

  private requirePageId(): string {
    if (!this.ctx.pageId) {
      throw new ChannelNotSupportedError("FACEBOOK (missing page binding)");
    }
    return this.ctx.pageId;
  }

  /** Native-shape normalization (live webhook path — lossless, tested). */
  receiveNative(payload: unknown, rawEventId?: string): NormalizedInboundMessage[] {
    return normalizeFacebookWebhook(
      payload as MetaWebhookPayload,
      this.ctx.channelAccountId,
      this.requirePageId(),
      rawEventId ?? deriveEventId(payload)
    );
  }

  receiveMessage(payload: unknown): NormalizedIncomingMessage[] {
    const normalized = this.receiveNative(payload);
    return normalized.map((m) => {
      const first = (m.attachments ?? [])[0];
      return {
        channelType: "FACEBOOK" as ChannelType,
        externalUserId: m.externalCustomerId,
        externalUserName: null,
        externalConversationId: m.externalConversationId,
        externalMessageId: m.externalMessageId,
        externalEventId: m.externalEventId,
        provider: this.provider,
        type: messageTypeOf(first?.type),
        text: m.text,
        mediaUrl: first?.url ?? null,
        metadata: {
          channelAccountId: m.channelAccountId,
          rawEventId: m.rawEventId,
          attachments: m.attachments ?? [],
          // P8 — إحالة موثوقة صريحة فقط (قد تكون null = غير معروف).
          adRef: m.adRef ?? null,
        },
        sentAt: m.timestamp,
      };
    });
  }

  async sendText(conversationRef: string, text: string): Promise<ChannelSendResult> {
    const res = await this.requireSender()(conversationRef, { text });
    return { externalMessageId: res.messageId, provider: this.provider, raw: { graphCode: res.graphCode } };
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
    return { externalMessageId: res.messageId, provider: this.provider, raw: { graphCode: res.graphCode } };
  }

  async markRead(): Promise<void> {
    // Messenger read receipts ride on sender actions in the outbound path;
    // the adapter intentionally does not freelance Graph calls.
  }
}
