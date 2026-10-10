/**
 * TikTok send policy (P5-E — LOCAL ONLY). Conservative documented default:
 * reply only inside 24h of the last inbound until the account's real
 * messaging limits are confirmed (BLOCKED external verification).
 */
export const TIKTOK_WINDOW_MS = 24 * 3600_000;

export interface TikTokPolicyContext {
  channelStatus: string;
  accessApproved: boolean;
  lastCustomerMessageAt?: Date | string | null;
  now?: number;
}

export type TikTokPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: "CHANNEL_DISCONNECTED" | "ACCESS_NOT_APPROVED" | "WINDOW_CLOSED" };

export function canSendTikTok(ctx: TikTokPolicyContext): TikTokPolicyDecision {
  if (ctx.channelStatus !== "CONNECTED") return { allowed: false, reason: "CHANNEL_DISCONNECTED" };
  if (!ctx.accessApproved) return { allowed: false, reason: "ACCESS_NOT_APPROVED" };
  const last = ctx.lastCustomerMessageAt ? new Date(ctx.lastCustomerMessageAt).getTime() : NaN;
  if (!Number.isFinite(last) || (ctx.now ?? Date.now()) - last > TIKTOK_WINDOW_MS) {
    return { allowed: false, reason: "WINDOW_CLOSED" };
  }
  return { allowed: true };
}
