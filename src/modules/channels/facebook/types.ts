/** Facebook-specific types — Meta payloads never leave this module. */

export interface NormalizedAttachment {
  type: "IMAGE" | "VIDEO" | "AUDIO" | "FILE" | "LOCATION" | "FALLBACK";
  url?: string;
}

export interface NormalizedInboundMessage {
  channelType: "FACEBOOK";
  channelAccountId: string;
  /** Page-scoped ID (PSID) of the sender. */
  externalCustomerId: string;
  externalConversationId: string;
  externalMessageId: string;
  externalEventId: string;
  text?: string | null;
  attachments?: NormalizedAttachment[];
  timestamp: Date;
  provider: string;
  rawEventId: string;
}

export interface FacebookPageRef {
  id: string;
  name: string;
  accessToken: string;
}

export type FacebookErrorKind = "TRANSIENT" | "PERMANENT";

export class FacebookApiError extends Error {
  constructor(
    message: string,
    public readonly kind: FacebookErrorKind,
    public readonly code?: number,
    public readonly subcode?: number
  ) {
    super(message);
    this.name = "FacebookApiError";
  }
}

/** Meta messaging window: 24h after the last customer message. */
export const HUMAN_AGENT_WINDOW_MS = 24 * 3600_000;
