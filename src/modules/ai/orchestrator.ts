import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { runGating } from "./stages/gating";
import { runExtraction } from "./stages/extraction";
import { runResponse } from "./stages/response";
import type {
  AIExecutionResult,
  OrchestratorDeps,
} from "./stages/state";

// Canonical homes: stages/state.ts (re-exported so existing import paths work).
export type { AIExecutionResult, OrchestratorDeps } from "./stages/state";

const log = childLogger("orchestrator");

/**
 * AIOrchestrator.process — the central pipeline (P1: sequencing only;
 * stage logic lives in stages/gating|extraction|response, verbatim):
 *
 * load message → idempotency → load conversation/customer/persona/settings →
 * intent+extraction (structured, Zod-validated, retry, heuristic fallback) →
 * memory load/save → context (Phase 3 buildAIContext, intent-scoped) →
 * deterministic response plan → handoff policy (injection/complaint/low
 * confidence) → generate response (retry) → guardrails (validate/regenerate/
 * fallback) → send as AI sender → citations + usage log.
 *
 * Deterministic guarantees:
 * - Only INBOUND messages are processed (AI outbound never re-enters — loop prevention).
 * - The same messageId is processed once (idempotency).
 * - A failed provider never fabricates a reply: AI_FAILED + original message preserved.
 */
export async function processAIMessage(
  db: Db,
  params: {
    conversationId: string;
    messageId: string;
    workspaceId: string;
    dryRun?: boolean;
  },
  deps: OrchestratorDeps = {}
): Promise<AIExecutionResult> {
  const pipelineStarted = Date.now();
  // Safe stage timings (ids + durations only — never message contents/secrets).
  const stageMs: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      stageMs[name] = (stageMs[name] ?? 0) + (Date.now() - s);
    }
  };
  const logTimings = (outcome: string, extra?: Record<string, unknown>) => {
    log.info(
      { conversationId: params.conversationId, messageId: params.messageId, outcome, pipelineMs: Date.now() - pipelineStarted, ...stageMs, ...extra },
      "ai_pipeline_timings"
    );
  };
  const fx = { pipelineStarted, stageMs, timed, logTimings };

  const gated = await runGating(db, params, deps, fx);
  if ("terminal" in gated) return gated.terminal;

  const extracted = await runExtraction(db, params, deps, fx, gated.state);
  if ("terminal" in extracted) return extracted.terminal;

  return runResponse(db, params, fx, gated.state, extracted.ready);
}
