import type { Prisma } from "@prisma/client";
import { childLogger } from "@/core/logger";
import {
  AIProviderError,
  MockAIProvider,
  OpenAICompatibleProvider,
  getInjectedMockProvider,
  normalizeHermesEndpoint,
  resolveAIProvider,
  type AIProvider,
} from "./provider";

const log = childLogger("ai-router");

export interface AISettingsLike {
  classificationModel: string | null;
  extractionModel: string | null;
  responseModel: string | null;
  visionModel: string | null;
  summaryModel: string | null;
  embeddingModel: string | null;
  // P6: optional self-hosted endpoint + explicit fallback.
  customBaseUrl?: string | null;
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
  provider?: string | null;
  temperature: number;
  maxTokens: number;
  confidenceExecute: number;
  confidenceRespond: number;
  humanHandoffThreshold: number;
  aiEnabled: boolean;
  autoRespond: boolean;
}

export type AiTask = "CLASSIFICATION" | "EXTRACTION" | "RESPONSE" | "VISION" | "SUMMARY" | "EMBEDDING" | "RETRIEVAL";

export const AI_TASKS: AiTask[] = ["CLASSIFICATION", "EXTRACTION", "RESPONSE", "VISION", "SUMMARY", "EMBEDDING", "RETRIEVAL"];

export const DEFAULT_MODELS: Record<AiTask, string> = {
  CLASSIFICATION: "gpt-4o-mini",
  EXTRACTION: "gpt-4o-mini",
  RESPONSE: "gpt-4o",
  VISION: "gpt-4o-mini",
  SUMMARY: "gpt-4o-mini",
  EMBEDDING: "text-embedding-3-small",
  RETRIEVAL: "text-embedding-3-small",
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
    embeddingModel?: string | null;
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
    EMBEDDING: process.env.EMBEDDING_MODEL,
    RETRIEVAL: process.env.EMBEDDING_MODEL,
  };
  const settingsModels: Record<AiTask, string | null> = {
    CLASSIFICATION: settings?.classificationModel ?? null,
    EXTRACTION: settings?.extractionModel ?? null,
    RESPONSE: settings?.responseModel ?? null,
    VISION: settings?.visionModel ?? null,
    SUMMARY: settings?.summaryModel ?? null,
    EMBEDDING: settings?.embeddingModel ?? null,
    RETRIEVAL: settings?.embeddingModel ?? null,
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
  // P6: published persona instructions that drove this call.
  personaId?: string | null;
  personaVersion?: number | null;
  fallbackUsed?: boolean;
  handoffReason?: string | null;
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
        personaId: rec.personaId ?? null,
        personaVersion: rec.personaVersion ?? null,
        fallbackUsed: rec.fallbackUsed ?? false,
        handoffReason: rec.handoffReason ?? null,
        promptTokens: rec.promptTokens,
        completionTokens: rec.completionTokens,
        costUsd: estimateCost(rec.model, rec.promptTokens, rec.completionTokens),
        latencyMs: rec.latencyMs,
        success: rec.success,
        status: rec.status ?? (rec.success ? "SUCCESS" : "FAILED"),
        error: rec.error ?? null,
      },
    });
  } catch {
    // P6: the failure cause is deliberately NOT logged — error objects from
    // storage layers may embed customer data (PII), and usage telemetry must
    // never become a PII sink. The call itself already succeeded; only safe
    // identifiers (workspace/purpose) are recorded.
    log.error(
      { workspaceId: rec.workspaceId, purpose: rec.purpose, model: rec.model },
      "ai_usage_log_failed"
    );
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

/**
 * Executes an AI call with retry + backoff.
 *
 * Durability contract: transient failures (timeouts, 429, 5xx) retry here for
 * fast recovery AND propagate as retryable AI_FAILED for the durable
 * job/sweeper backoff. Permanent failures (bad credentials, unknown model)
 * fail FAST — no hammering — while the message stays operator-visible and
 * recoverable via the orphan sweeper once configuration is corrected.
 */
const MAX_RETRY_AFTER_WAIT_MS = 5_000; // longer waits belong to durable backoff, not the worker slot
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
      // Permanent provider errors never succeed on immediate retry — surface
      // them at once so the durable layers (job backoff, orphan sweeper) own
      // the timeline instead of burning worker time.
      if (lastErr instanceof AIProviderError && !lastErr.retryable) throw lastErr;
      if (i < attempts) {
        let waitMs = 50 * 2 ** i;
        // Respect the server's Retry-After hint, capped so a long hint never
        // parks the worker; the durable backoff covers the remainder.
        if (lastErr instanceof AIProviderError && lastErr.retryAfterMs !== undefined) {
          waitMs = Math.max(waitMs, Math.min(lastErr.retryAfterMs, MAX_RETRY_AFTER_WAIT_MS));
        }
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

export function isProviderAvailable(provider: AIProvider): boolean {
  return provider.name !== "mock" || Boolean(process.env.ALLOW_MOCK_AI);
}

// ── P6: task/model compatibility ──────────────────────────────────────────
// Models are NOT interchangeable: an embedding model cannot generate replies
// and a chat model cannot produce vectors. This check is advisory data for
// the studio UI and pre-flight validation — the pipeline itself always calls
// resolveModel per task, so a misconfigured name fails fast at the provider
// with a visible error instead of silently degrading.

const EMBEDDING_HINT = /embed/i;
const VISION_HINT = /vision|gpt-4o|claude-3|gemini.*vision/i;

export function validateTaskModel(
  task: AiTask,
  model: string
): { compatible: boolean; reason: string } {
  const m = model.trim();
  if (!m) return { compatible: false, reason: "EMPTY_MODEL" };
  if (task === "EMBEDDING" || task === "RETRIEVAL") {
    if (EMBEDDING_HINT.test(m) || m.startsWith("hash-")) {
      return { compatible: true, reason: "OK" };
    }
    return { compatible: false, reason: "MODEL_NOT_EMBEDDING_CAPABLE" };
  }
  if (task === "VISION") {
    if (EMBEDDING_HINT.test(m)) {
      return { compatible: false, reason: "MODEL_NOT_VISION_CAPABLE" };
    }
    return { compatible: true, reason: "OK" };
  }
  // Chat tasks: embedding-only models are rejected; anything else passes
  // (provider-side errors stay visible via AI_FAILED, never hidden).
  if (EMBEDDING_HINT.test(m)) {
    return { compatible: false, reason: "MODEL_NOT_CHAT_CAPABLE" };
  }
  return { compatible: true, reason: "OK" };
}

// ── P6: workspace-aware provider resolution ───────────────────────────────
// Makes the AISettings.provider choice EFFECTIVE (previously the settings
// page offered mock/openai/openrouter but getAIProvider only read ENV, so
// the UI selection did nothing). Workspace choice wins when its key is
// present; otherwise ENV is the fallback; otherwise fail-closed. A workspace
// customBaseUrl builds an INTERNAL OpenAI-compatible provider (delivery
// "internal", tested independently — never claimed internal by name alone).

export function getWorkspaceProvider(
  settings: {
    provider?: string | null;
    customBaseUrl?: string | null;
    responseModel?: string | null;
  } | null,
  env?: {
    aiProvider?: string;
    openaiKey?: string;
    openrouterKey?: string;
    hermesBaseUrl?: string;
    hermesKey?: string;
    hermesModel?: string;
    responseModel?: string;
    nodeEnv?: string;
    allowMockAi?: string;
  }
): AIProvider {
  const injected = getInjectedMockProvider();
  if (injected) return injected;
  const e = env ?? {
    aiProvider: process.env.AI_PROVIDER,
    openaiKey: process.env.OPENAI_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY,
    hermesBaseUrl: process.env.HERMES_BASE_URL,
    hermesKey: process.env.HERMES_API_KEY,
    hermesModel: process.env.HERMES_MODEL,
    responseModel: process.env.RESPONSE_MODEL,
    nodeEnv: process.env.NODE_ENV,
    allowMockAi: process.env.ALLOW_MOCK_AI,
  };
  // Precedence (P6): an explicit workspace choice of a REAL provider
  // (openai/openrouter/internal/hermes) is effective and fail-closed on a
  // missing key. A workspace "mock"/unset DEFERS to ENV — so a misconfigured
  // ENV still fail-closes exactly as before (no behavior change for existing
  // deployments), while a workspace can still opt into a real provider whose
  // key exists even when ENV names no provider.
  const wsChoice = settings?.provider ?? null;
  const wsWantsReal = wsChoice === "openai" || wsChoice === "openrouter" || wsChoice === "internal" || wsChoice === "hermes";
  const choice = wsWantsReal ? wsChoice : e.aiProvider ?? wsChoice ?? null;
  const keyFor = (p: string | null | undefined) =>
    p === "openai" ? e.openaiKey : p === "openrouter" ? e.openrouterKey : p === "hermes" ? e.hermesKey : undefined;
  // Hermes Agent (OpenAI-compatible gateway). Endpoint comes from server ENV
  // (HERMES_BASE_URL — localhost/LAN allowed, it is deployer-trusted, not a
  // workspace-user URL, so the SSRF guard for customBaseUrl does not apply).
  // A workspace customBaseUrl may still override it for public Hermes
  // endpoints (then the save/probe SSRF guard applies as usual).
  if (choice === "hermes") {
    const override = settings?.customBaseUrl?.trim();
    const base = override || e.hermesBaseUrl?.trim();
    const key = e.hermesKey?.trim();
    if (!base || !key) {
      throw new AIProviderError(
        `AI_NOT_CONFIGURED: provider "hermes" needs HERMES_BASE_URL + HERMES_API_KEY in server env${override ? "" : " (or a public customBaseUrl on the workspace)"}. Refusing mock fallback — no fake replies will be sent.`
      );
    }
    return new OpenAICompatibleProvider({
      name: "hermes",
      apiKey: key,
      baseUrl: normalizeHermesEndpoint(base),
      defaultModel: settings?.responseModel ?? e.hermesModel ?? e.responseModel ?? "hermes-agent",
    });
  }
  // Self-hosted endpoint: explicit opt-in per workspace. Delivery is declared
  // "internal" at construction (privacy-gate trusts the flag, not the name).
  const base = settings?.customBaseUrl?.trim();
  if (base && (choice === "openai" || choice === "openrouter" || choice === "internal")) {
    const key = keyFor(choice) ?? "internal-endpoint";
    return new OpenAICompatibleProvider({
      name: "internal",
      apiKey: key,
      baseUrl: base,
      defaultModel: settings?.responseModel ?? e.responseModel ?? "gpt-4o-mini",
      delivery: "internal",
    });
  }
  if ((choice === "openai" || choice === "openrouter") && keyFor(choice)) {
    const isOpenai = choice === "openai";
    return new OpenAICompatibleProvider({
      name: choice,
      apiKey: keyFor(choice)!,
      baseUrl: isOpenai ? "https://api.openai.com/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions",
      defaultModel: settings?.responseModel ?? e.responseModel ?? (isOpenai ? "gpt-4o-mini" : "openai/gpt-4o-mini"),
    });
  }
  if (choice === "mock") {
    const allowed =
      e.nodeEnv === "test" ||
      ["1", "true", "yes"].includes((e.allowMockAi ?? "").toLowerCase()) ||
      (e.nodeEnv !== "production" && !e.aiProvider);
    if (allowed) return new MockAIProvider();
  }
  // Fall back to the global ENV resolution (preserves legacy behavior and
  // keeps every existing test green); it fail-closes when unconfigured.
  return resolveAIProvider({
    aiProvider: e.aiProvider,
    openaiKey: e.openaiKey,
    openrouterKey: e.openrouterKey,
    hermesBaseUrl: e.hermesBaseUrl,
    hermesKey: e.hermesKey,
    hermesModel: e.hermesModel,
    responseModel: e.responseModel,
    nodeEnv: e.nodeEnv,
    allowMockAi: e.allowMockAi,
  });
}

// ── P6: configured fallback (failover only, never policy bypass) ──────────
// Both primary and fallback calls MUST already be privacy-gated by the
// caller (sendProtected*). This helper only decides WHEN a second attempt is
// allowed: a configured fallbackModel + a retryable primary failure.

export function getFallbackModel(settings: AISettingsLike | null): string | null {
  const m = settings?.fallbackModel?.trim();
  return m ? m : null;
}

export async function executeWithFallback<T>(
  primary: () => Promise<T>,
  opts: { fallbackModel: string | null; runFallback: (model: string) => Promise<T> }
): Promise<{ result: T; fallbackUsed: boolean }> {
  try {
    return { result: await primary(), fallbackUsed: false };
  } catch (err) {
    if (!opts.fallbackModel) throw err;
    // Permanent configuration errors are never retried on a second model —
    // surface them immediately (operator-visible, no hammering).
    if (err instanceof AIProviderError && !err.retryable) throw err;
    return { result: await opts.runFallback(opts.fallbackModel), fallbackUsed: true };
  }
}
