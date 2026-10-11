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
  /** P8 — مصدر إحالة موثوق من Meta (referral/postback ref) إن وُجد. */
  adRef?: string | null;
  /** P12 — الإحالة كاملة (رقم الإعلان من «انقر للمراسلة» أو ref رابط m.me). */
  referral?: FacebookReferral | null;
}

/** P12 — إحالة ماسنجر/إنستغرام مطبّعة (ad_id للإعلان · ref لرابط الرمز). */
export interface FacebookReferral {
  source: "fb_referral" | "fb_ref_link" | "ig_referral" | "ig_ref_link";
  adId: string | null;
  adSourceType: string | null;
  ref: string | null;
  pageId: string | null;
}

/** P12 — إحالة بلا رسالة (messaging_referrals لمحادثة قائمة). */
export interface FacebookReferralSignal {
  psid: string;
  referral: FacebookReferral;
  timestamp: Date;
  eventKey: string;
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
    public readonly subcode?: number,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "FacebookApiError";
  }
}

/** Meta messaging window: 24h after the last customer message. */
export const HUMAN_AGENT_WINDOW_MS = 24 * 3600_000;
