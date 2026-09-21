import crypto from "node:crypto";

/**
 * Lightweight correlation IDs (OpenTelemetry-compatible later).
 * The chain: webhookEventId → message.metadata.correlationId → AIUsageLog.messageId
 * → order.conversationId → automationExecution.triggerEventId — every hop
 * records the previous ID so a trace can be reconstructed from the DB.
 */
export function newCorrelationId(prefix = "corr"): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function newRequestId(): string {
  return `req_${crypto.randomBytes(6).toString("hex")}`;
}
