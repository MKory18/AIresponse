/**
 * WhatsApp send policy (P5-D). Documented Cloud API rules (verified 2026):
 * a 24h customer-service window opens on every user inbound (voice calls
 * count too) and resets on each new inbound; inside it free-form service
 * messages are allowed; outside it ONLY approved templates may go out.
 * Template sending is not implemented in P5 → outside-window freeform
 * refuses with a clear policy reason (never a silent campaign).
 */
export const WHATSAPP_WINDOW_MS = 24 * 3600_000;

export interface WhatsAppPolicyContext {
  channelStatus: string;
  tokenValid: boolean;
  lastCustomerMessageAt?: Date | string | null;
  now?: number;
}

export type WhatsAppPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: "CHANNEL_DISCONNECTED" | "TOKEN_INVALID" | "WINDOW_CLOSED_TEMPLATE_REQUIRED" };

export function canSendWhatsApp(ctx: WhatsAppPolicyContext): WhatsAppPolicyDecision {
  if (ctx.channelStatus !== "CONNECTED") return { allowed: false, reason: "CHANNEL_DISCONNECTED" };
  if (!ctx.tokenValid) return { allowed: false, reason: "TOKEN_INVALID" };
  const last = ctx.lastCustomerMessageAt ? new Date(ctx.lastCustomerMessageAt).getTime() : NaN;
  if (!Number.isFinite(last) || (ctx.now ?? Date.now()) - last > WHATSAPP_WINDOW_MS) {
    return { allowed: false, reason: "WINDOW_CLOSED_TEMPLATE_REQUIRED" };
  }
  return { allowed: true };
}
