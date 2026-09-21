import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";
import { AIProviderError, type AIProvider } from "./provider";

const log = childLogger("ai-router");

export interface AISettingsLike {
  classificationModel: string | null;
  extractionModel: string | null;
  responseModel: string | null;
  visionModel: string | null;
  summaryModel: string | null;
  embeddingModel: string | null;
  temperature: number;
  maxTokens: number;
  confidenceExecute: number;
  confidenceRespond: number;
  humanHandoffThreshold: number;
  aiEnabled: boolean;
  autoRespond: boolean;
}

export type AiTask = "CLASSIFICATION" | "EXTRACTION" | "RESPONSE" | "VISION" | "SUMMARY";

export const DEFAULT_MODELS: Record<AiTask, string> = {
  CLASSIFICATION: "gpt-4o-mini",
  EXTRACTION: "gpt-4o-mini",
  RESPONSE: "gpt-4o",
  VISION: "gpt-4o-mini",
  SUMMARY: "gpt-4o-mini",
};

/** Rough per-model cost per 1K tokens (USD) — estimates only, for usage logs. */
const COST_PER_1K: Record<string, number> = {
  "gpt-4o-mini": 0.0006,
  "gpt-4o": 0.005,

};

export interface ResolvedModel {
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Model router: picks model/temperature/maxTokens per task from workspace
 * AISettings with ENV fallback. Cost-aware: classification/extraction/summary
 * default to the cheap model; only RESPONSE defaults to the strong one.
 */
export function resolveModel(
  settings: {
    classificationModel: string | null;
    extractionModel: string | null;
    responseModel: string | null;
    visionModel: string | null;
    summaryModel: string | null;
    temperature: number;
    maxTokens: number;
  } | null,
  task: AiTask
): ResolvedModel {
  const envModels: Record<AiTask, string | undefined> = {
    CLASSIFICATION: process.env.CLASSIFICATION_MODEL,
    EXTRACTION: process.env.EXTRACTION_MODEL,
    RESPONSE: process.env.RESPONSE_MODEL,
    VISION: process.env.VISION_MODEL,
    SUMMARY: process.env.SUMMARY_MODEL,
  };
  const settingsModels: Record<AiTask, string | null> = {
    CLASSIFICATION: settings?.classificationModel ?? null,
    EXTRACTION: settings?.extractionModel ?? null,
    RESPONSE: settings?.responseModel ?? null,
    VISION: settings?.visionModel ?? null,
    SUMMARY: settings?.summaryModel ?? null,
  };
  // Temperature strategy: extraction/classification want determinism.
  const temperature =
    task === "CLASSIFICATION" || task === "EXTRACTION"
      ? Math.min(settings?.temperature ?? 0.4, 0.2)
      : settings?.temperature ?? 0.4;
  const maxTokens =
    task === "RESPONSE" ? settings?.maxTokens ?? 500 : task === "SUMMARY" ? 300 : 250;

  return {
    model: settingsModels[task] || envModels[task] || DEFAULT_MODELS[task],
    temperature,
    maxTokens,
  };
}

export async function loadAISettings(db: { aISettings: { findUnique: (args: { where: { workspaceId: string } }) => Promise<unknown> } }, workspaceId: string) {
  return db.aISettings.findUnique({ where: { workspaceId } });
}

/**
 * Estimated cost — deterministic from configured pricing. When the model has
 * no configured pricing (or is a mock) the cost is NULL, never a fake $0.
 */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number | null {
  const rate = COST_PER_1K[model];
  if (rate === undefined) return null;
  return Number((((promptTokens + completionTokens) / 1000) * rate).toFixed(6));
}

export interface UsageRecord {
  workspaceId: string;
  conversationId?: string | null;
  messageId?: string | null;
  purpose: AiTask | string;
  provider: string;
  model: string;
  intent?: string | null;
  confidence?: number | null;
  promptVersion?: string | null;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  status?: string;
  error?: string | null;
}

/** Persists an AI usage/execution log row. Never throws. */
export async function logUsage(db: any, rec: UsageRecord): Promise<void> {
  try {
    await db.aIUsageLog.create({
      data: {
        workspaceId: rec.workspaceId,
        conversationId: rec.conversationId ?? null,
        messageId: rec.messageId ?? null,
        purpose: rec.purpose,
        provider: rec.provider,
        model: rec.model,
        intent: rec.intent ?? null,
        confidence: rec.confidence ?? null,
        promptVersion: rec.promptVersion ?? null,
        promptTokens: rec.promptTokens,
        completionTokens: rec.completionTokens,
        costUsd: estimateCost(rec.model, rec.promptTokens, rec.completionTokens),
        latencyMs: rec.latencyMs,
        success: rec.success,
        status: rec.status ?? (rec.success ? "SUCCESS" : "FAILED"),
        error: rec.error ?? null,
      },
    });
  } catch (err) {
    log.error({ err }, "ai_usage_log_failed");
  }
  // Usage metering (fire-and-forget; incrementUsage is failure-isolated).
  try {
    const { incrementUsage } = await import("@/core/analytics/usage-service");
    await incrementUsage(db as never, rec.workspaceId, {
      aiCalls: 1,
      aiInputTokens: rec.promptTokens,
      aiOutputTokens: rec.completionTokens,
    });
  } catch {
    // never break logging
  }
}

/** Executes an AI call with retry + backoff and usage logging. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; onRetry?: (attempt: number, err: Error) => void } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let lastErr: Error = new AIProviderError("unreachable");
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      opts.onRetry?.(i, lastErr);
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 50 * 2 ** i));
      }
    }
  }
  throw lastErr;
}

export function isProviderAvailable(provider: AIProvider): boolean {
  return provider.name !== "mock" || Boolean(process.env.ALLOW_MOCK_AI);
}
