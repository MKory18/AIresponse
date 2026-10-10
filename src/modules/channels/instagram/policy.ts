/**
 * Instagram send policy (P5-B). Conservative documented assumption: the same
 * 24-hour standard messaging window as the Messenger family applies to
 * Instagram professional accounts (provider docs describe the window for
 * Messenger; Instagram-specific exceptions, if any, fail safe here).
 */
export const INSTAGRAM_WINDOW_MS = 24 * 3600_000;

export interface InstagramPolicyContext {
  channelStatus: string;
  tokenExpiresAt?: Date | string | null;
  lastCustomerMessageAt?: Date | string | null;
  now?: number;
}

export type InstagramPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: "CHANNEL_DISCONNECTED" | "TOKEN_EXPIRED" | "WINDOW_CLOSED" };

export function canSendInstagram(ctx: InstagramPolicyContext): InstagramPolicyDecision {
  if (ctx.channelStatus !== "CONNECTED") return { allowed: false, reason: "CHANNEL_DISCONNECTED" };
  if (ctx.tokenExpiresAt && new Date(ctx.tokenExpiresAt).getTime() <= (ctx.now ?? Date.now())) {
    return { allowed: false, reason: "TOKEN_EXPIRED" };
  }
  const last = ctx.lastCustomerMessageAt ? new Date(ctx.lastCustomerMessageAt).getTime() : NaN;
  if (!Number.isFinite(last) || (ctx.now ?? Date.now()) - last > INSTAGRAM_WINDOW_MS) {
    return { allowed: false, reason: "WINDOW_CLOSED" };
  }
  return { allowed: true };
}
