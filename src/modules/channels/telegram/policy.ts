/**
 * Telegram send policy (P5-C). Documented Bot API behavior: a bot can only
 * message users that started it (/start) — structurally guaranteed here
 * because sends always target an existing conversation row. No 24h window
 * applies, so text is allowed whenever the connection is healthy.
 */
export interface TelegramPolicyContext {
  channelStatus: string;
  tokenValid: boolean;
}

export type TelegramPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: "CHANNEL_DISCONNECTED" | "TOKEN_INVALID" };

export function canSendTelegram(ctx: TelegramPolicyContext): TelegramPolicyDecision {
  if (ctx.channelStatus !== "CONNECTED") return { allowed: false, reason: "CHANNEL_DISCONNECTED" };
  if (!ctx.tokenValid) return { allowed: false, reason: "TOKEN_INVALID" };
  return { allowed: true };
}
