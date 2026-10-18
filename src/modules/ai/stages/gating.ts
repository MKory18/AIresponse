/**
 * Pipeline stage 1 — gating (P1 split of orchestrator.ts, verbatim logic).
 *
 * Load message → idempotency → conversation state → config/persona/customer/
 * history → provider resolution. Terminal outcomes (SKIPPED / NOT_INBOUND /
 * DUPLICATE / AI_DISABLED / AI_FAILED) return directly; otherwise the loaded
 * state passes to the extraction stage. No model is called here.
 */
import { childLogger } from "@/core/logger";
import { NotFoundError } from "@/core/errors";
import type { AIProvider } from "../provider";
import { loadAISettings, logUsage, getWorkspaceProvider, type AISettingsLike } from "../router";
import { PROMPT_VERSIONS, type PersonaConfig } from "../prompts";
import { resolveChannelPersona } from "../channel-persona";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import type {
  AIExecutionResult,
  GatingState,
  OrchestratorDeps,
  PipelineFx,
  PipelineParams,
} from "./state";

const log = childLogger("orchestrator");

// P0: freshness bound for the ordering guard (minutes). A deferral only
// makes sense while the older sibling is plausibly being answered RIGHT
// NOW (live job) or arrived moments ago (enqueue race). An older message
// that sat undecided beyond this window with no live job is stale —
// deferring every newer reply behind it burns worker cycles in a
// defer→sweep→re-enqueue loop and stalls the whole conversation.
// Mirror of ORPHAN_MAX_AGE_HOURS philosophy: bounded, env-tunable.
const ORDERING_GUARD_FRESH_MINUTES = Math.max(
  1,
  parseInt(process.env.ORDERING_GUARD_FRESH_MINUTES ?? "30", 10) || 30
);

export async function runGating(
  db: Db,
  params: PipelineParams,
  deps: OrchestratorDeps,
  fx: PipelineFx
): Promise<{ terminal: AIExecutionResult } | { state: GatingState }> {
  const { timed, pipelineStarted, logTimings } = fx;
  // 1. Load message — only inbound customer messages drive the AI.
  const message = await timed("messageLoad", () => db.message.findUnique({ where: { id: params.messageId } }));
  if (!message || message.workspaceId !== params.workspaceId || message.conversationId !== params.conversationId) {
    return { terminal: { status: "SKIPPED" } };
  }
  if (message.direction !== "INBOUND" || message.senderType !== "CUSTOMER") {
    return { terminal: { status: "NOT_INBOUND" } }; // AI loop prevention
  }

  // 2. Idempotency: one successful AI execution per message (failed runs are
  // retried by the job queue and must not be blocked).
  // 3. Conversation state gating (+ soft-deleted threads never run AI).
  // Independent reads run in parallel to cut latency without losing safety.
  // The guard covers TERMINAL RESPONSE decisions only: SUCCESS (answered) and
  // HANDOFF (intentional human path). AI_DISABLED is deliberately NOT here —
  // it is a reprocessable condition: a message recorded while AI was
  // temporarily off must be eligible again once the conversation returns to
  // AI_ACTIVE (sweeper + redelivered jobs), instead of being silenced forever.
  const [existing, conversation] = await timed("gating", () => Promise.all([
    db.aIUsageLog.findFirst({
      where: { messageId: message.id, purpose: "RESPONSE", status: { in: ["SUCCESS", "HANDOFF"] } },
      select: { id: true },
    }),
    db.conversation.findUnique({ where: { id: params.conversationId } }),
  ]));
  if (existing && !params.dryRun) return { terminal: { status: "DUPLICATE", executionId: existing.id } };
  if (!conversation || conversation.workspaceId !== params.workspaceId) throw new NotFoundError("Conversation");
  if ((conversation as { deletedAt?: Date | null }).deletedAt) return { terminal: { status: "SKIPPED" } };
  if (!conversation.aiEnabled || conversation.aiState !== "AI_ACTIVE") {
    if (!params.dryRun) {
      // Visible but NOT terminal: without this log the message would sit with
      // no reply, no alert, and no record — indistinguishable from lost. The
      // orphan sweeper re-enqueues it automatically if AI is re-enabled.
      await logUsage(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        messageId: message.id,
        purpose: "RESPONSE",
        provider: "none",
        model: "none",
        promptVersion: PROMPT_VERSIONS.RESPONSE,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - pipelineStarted,
        success: true,
        status: "AI_DISABLED",
      });
      return { terminal: { status: "AI_DISABLED" } };
    }
    return { terminal: { status: "AI_DISABLED" } };
  }

  // 3b. Per-conversation ordering: never answer a message while an OLDER
  // sibling in the same conversation is still likely to be answered. Two
  // overlapping executors (worker + jobs/run, scaled workers) or a retry
  // racing fresh work could otherwise deliver the older reply AFTER the
  // newer one. Deferral is a terminal success-noop — no send, no logs
  // written: the orphan sweeper re-enqueues this message once the older
  // sibling is decided. Older siblings always win, so nothing starves:
  // the oldest undecided message in a conversation never defers.
  // Runs only when the conversation is AI-active (checked above), so a
  // deferral always resolves instead of waiting on a dead thread.
  if (!params.dryRun) {
    // createdAt may arrive stringified through serialized test doubles —
    // normalize so the comparison is a real date comparison everywhere.
    const msgTime = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);
    const older = await timed("ordering", () =>
      db.message.findFirst({
        where: {
          conversationId: params.conversationId,
          direction: "INBOUND",
          senderType: "CUSTOMER",
          deletedAt: null,
          OR: [
            { createdAt: { lt: msgTime } },
            { createdAt: msgTime, id: { lt: message.id } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, createdAt: true },
      })
    );
    if (older) {
      const olderLogs = await timed("ordering", () =>
        db.aIUsageLog.findMany({
          where: { messageId: older.id, purpose: "RESPONSE" },
          select: { status: true },
        })
      );
      const olderDecided = olderLogs.some((l) => l.status === "SUCCESS" || l.status === "HANDOFF");
      if (!olderDecided) {
        const hasFailed = olderLogs.some((l) => l.status === "AI_FAILED");
        const liveJob = await timed("ordering", () =>
          (db as any).backgroundJob.findFirst({
            where: {
              type: "process_ai_message",
              idempotencyKey: `ai:${older.id}`,
              status: { in: ["PENDING", "PROCESSING"] },
            },
            select: { id: true },
          })
        );
        const olderLive = !!liveJob;
        // P0: a LIVE older turn defers at any age (its answer is genuinely
        // in flight). Otherwise only a FRESH older sibling may defer: beyond
        // ORDERING_GUARD_FRESH_MINUTES with no live job, nobody is answering
        // it imminently, so holding every newer reply hostage stalls the
        // conversation (pre-guard behavior resumes, logged).
        const olderCreated = (older as { createdAt?: Date | string }).createdAt;
        const olderTime = olderCreated instanceof Date ? olderCreated.getTime() : new Date(olderCreated as string).getTime();
        const olderFresh = Number.isFinite(olderTime) && Date.now() - olderTime < ORDERING_GUARD_FRESH_MINUTES * 60_000;
        if (olderLive || (!hasFailed && olderFresh)) {
          log.info(
            { conversationId: conversation.id, messageId: message.id, olderMessageId: older.id },
            "ai_deferred_older_sibling"
          );
          logTimings("DEFERRED", { olderMessageId: older.id });
          return { terminal: { status: "DEFERRED", error: `OLDER_SIBLING_UNDECIDED:${older.id}` } };
        }
        log.info(
          { conversationId: conversation.id, messageId: message.id, olderMessageId: older.id },
          hasFailed ? "ai_ordering_proceed_older_failed" : "ai_ordering_proceed_older_stale"
        );
      }
    }
  }

  log.info(
    { conversationId: conversation.id, messageId: message.id, workspaceId: params.workspaceId },
    "ai_started"
  );

  // 4. Config + persona (page-assigned → workspace default) + customer +
  // channel page + recent history: independent reads in parallel. History has
  // no dependency on the others — serializing it wasted one full DB round-trip
  // on every single AI turn (critical-path latency). Persona resolution is
  // ALWAYS active: the selected persona (channel → workspace default →
  // builtin) drives reply voice in every provider mode, including Hermes —
  // Hermes carries no personaId parameter, so local instructions travel in
  // the request via the standard message builder.
  const [settingsRaw, resolvedPersona, customer, recentMessagesRaw] = await timed("config", () => Promise.all([
    loadAISettings(db, params.workspaceId),
    resolveChannelPersona(db, { workspaceId: params.workspaceId, channelId: conversation.channelId }),
    db.customer.findUnique({ where: { id: conversation.customerId } }),
    db.message.findMany({
      where: { conversationId: conversation.id, deletedAt: null, isNote: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
      select: { senderType: true, direction: true, text: true },
    }),
  ]));
  // PERF — the channel row is read once inside resolveChannelPersona (scope
  // + assignment + display fields); reuse its display fields here instead of
  // a second channel.findUnique. Same data, fully parallel as before.
  const channelRow = resolvedPersona.channelPage;
  const settings = settingsRaw as AISettingsLike | null;
  if (settings && (!settings.aiEnabled || settings.autoRespond === false)) {
    if (!params.dryRun) {
      // Visible but NOT terminal (reprocessable once settings re-enable AI).
      await logUsage(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        messageId: message.id,
        purpose: "RESPONSE",
        provider: "none",
        model: "none",
        promptVersion: PROMPT_VERSIONS.RESPONSE,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - pipelineStarted,
        success: true,
        status: "AI_DISABLED",
      });
    }
    return { terminal: { status: "AI_DISABLED" } };
  }
  if (!customer) throw new NotFoundError("Customer");

  // Fail-closed: a misconfigured real provider must never produce fake
  // replies. Surface AI_FAILED (job retry + audit) with zero outbound sends
  // and zero order/memory writes — the conversation stays OPEN and the
  // failure remains visible and reprocessable.
  // P6: the workspace AISettings.provider choice is EFFECTIVE (not display-
  // only): resolution prefers it when its key exists, else ENV, else throws.
  let provider: AIProvider;
  try {
    provider = deps.provider ?? getWorkspaceProvider(settings as never);
  } catch (err) {
    const message_text = err instanceof Error ? err.message : String(err);
    log.error({ err: message_text, conversationId: conversation.id }, "ai_provider_not_configured");
    log.warn({ conversationId: conversation.id, messageId: message.id, retryable: false }, "ai_failed");
    if (!params.dryRun) {
      await logUsage(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        messageId: message.id,
        purpose: "RESPONSE",
        provider: "unconfigured",
        model: "none",
        promptVersion: PROMPT_VERSIONS.RESPONSE,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        success: false,
        status: "AI_FAILED",
        error: `PERMANENT: ${message_text}`,
      });
      await recordAudit(db, {
        workspaceId: params.workspaceId,
        action: "conversation.ai_failed",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { reason: "AI_NOT_CONFIGURED" },
      });
    }
    return { terminal: { status: "AI_FAILED", error: `PERMANENT: ${message_text}` } };
  }

  // Persona resolution — ALWAYS active. The selected persona (channel →
  // workspace default → builtin) drives reply voice in every provider mode:
  // the published local instructions travel inside the request via the
  // standard message builder (proven by tests). Telemetry records the real
  // persona id/version.
  const persona: PersonaConfig = {
    name: resolvedPersona.name,
    language: resolvedPersona.language,
    dialect: resolvedPersona.dialect,
    tone: resolvedPersona.tone,
    formality: resolvedPersona.formality,
    responseLength: resolvedPersona.responseLength,
    emojiLevel: resolvedPersona.emojiLevel,
    salesStyle: resolvedPersona.salesStyle,
    systemInstructions: resolvedPersona.systemInstructions,
    prohibitedPhrases: resolvedPersona.prohibitedPhrases,
    customRules: resolvedPersona.customRules,
  };
  const activePersona = { id: resolvedPersona.id, name: resolvedPersona.name, source: resolvedPersona.source, version: resolvedPersona.version };
  // P1 privacy gate: customer PII leaves the process ONLY through
  // sendProtected* (per-call token vault, restored locally afterwards).
  const customerPII = {
    name: (customer as { name?: string | null }).name ?? null,
    phone: (customer as { phone?: string | null }).phone ?? null,
    email: (customer as { email?: string | null }).email ?? null,
    address: (customer as { address?: string | null }).address ?? null,
  };
  const trustedContacts = customerPII.phone ? [customerPII.phone] : [];
  const customerText = message.text ?? "[رسالة وسائط]";
  const recentMessages = recentMessagesRaw as { senderType: string; direction: string; text: string | null }[];
  // Bound per-message chars so one huge turn can't blow up every prompt.
  for (const m of recentMessages) {
    if (m.text && m.text.length > 500) m.text = m.text.slice(0, 500);
  }

  return {
    state: {
      message,
      conversation,
      settings,
      persona,
      activePersona,
      customer,
      channelRow,
      customerText,
      recentMessages,
      customerPII,
      trustedContacts,
      provider,
    },
  };
}
