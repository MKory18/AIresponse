import { randomId } from "@/core/crypto";
import type { ChannelType } from "@prisma/client";
import type {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutboundMessage,
} from "./types";

/**
 * Development/test adapter. Accepts a simple normalized envelope and echoes
 * deterministic results so the full pipeline works without external APIs.
 */
export class MockChannelAdapter implements ChannelAdapter {
  readonly channelType: ChannelType;
  readonly provider = "mock";

  constructor(channelType: ChannelType) {
    this.channelType = channelType;
  }

  receiveMessage(payload: unknown): NormalizedIncomingMessage[] {
    const p = payload as Partial<NormalizedIncomingMessage>;
    if (!p?.externalUserId || !p?.externalMessageId) return [];
    return [
      {
        channelType: this.channelType,
        externalUserId: p.externalUserId,
        externalUserName: p.externalUserName ?? null,
        externalConversationId: p.externalConversationId ?? p.externalUserId,
        externalMessageId: p.externalMessageId,
        externalEventId: p.externalEventId ?? p.externalMessageId,
        provider: this.provider,
        type: p.type ?? "TEXT",
        text: p.text ?? null,
        mediaUrl: p.mediaUrl ?? null,
        metadata: p.metadata ?? {},
      },
    ];
  }

  async sendText(conversationRef: string, text: string): Promise<ChannelSendResult> {
    return {
      externalMessageId: `mock-${randomId(8)}`,
      provider: this.provider,
      raw: { conversationRef, text },
    };
  }

  async sendMedia(
    conversationRef: string,
    message: OutboundMessage
  ): Promise<ChannelSendResult> {
    return {
      externalMessageId: `mock-${randomId(8)}`,
      provider: this.provider,
      raw: { conversationRef, ...message },
    };
  }

  async markRead(conversationRef: string, externalMessageId: string): Promise<void> {
    void conversationRef;
    void externalMessageId;
  }
}
