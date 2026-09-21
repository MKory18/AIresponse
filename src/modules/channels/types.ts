/**
 * Channel abstraction. Meta/WhatsApp/Telegram adapters (Phase 6) implement the
 * same interface; the platform never talks to a channel SDK directly.
 */
import type { ChannelType, MessageType } from "@prisma/client";

export interface NormalizedIncomingMessage {
  channelType: ChannelType;
  /** External user id on that channel (page-scoped, phone, chat idâ€¦). */
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
