
export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: "CHANNEL_DISCONNECTED" | "TOKEN_EXPIRED" | "WINDOW_CLOSED" };

export interface PolicyContext {
  channelStatus: string;
  tokenExpiresAt: Date | null;
  /** Timestamp of the customer's last inbound message (24h window anchor). */
  lastCustomerMessageAt: Date | null;
  now?: Date;
}

/**
 * MessagingPolicyService â€” enforces Meta's messaging rules so the AI can
 * never bypass them. Kept separate from the orchestrator and easy to update
 * as Meta policy evolves.
 */
export function canSendToCustomer(ctx: PolicyContext): PolicyDecision {
  const now = ctx.now ?? new Date();
  if (ctx.channelStatus !== "CONNECTED") {
    return { allowed: false, reason: "CHANNEL_DISCONNECTED" };
  }
  if (ctx.tokenExpiresAt && new Date(ctx.tokenExpiresAt).getTime() < now.getTime()) {
    return { allowed: false, reason: "TOKEN_EXPIRED" };
  }
  if (
    !ctx.lastCustomerMessageAt ||
    now.getTime() - new Date(ctx.lastCustomerMessageAt).getTime() > HUMAN_AGENT_WINDOW_MS
  ) {
    return { allowed: false, reason: "WINDOW_CLOSED" };
  }
  return { allowed: true };
}

const HUMAN_AGENT_WINDOW_MS = 24 * 3600_000;
