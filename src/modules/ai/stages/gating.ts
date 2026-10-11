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
import { loadAISettings, logUsage, getWorkspaceProvider, isHermesSelected, isHermesPersonaMode, type AISettingsLike } from "../router";
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

export async function runGating(
  db: Db,
  params: PipelineParams,
  deps: OrchestratorDeps,
  fx: PipelineFx
): Promise<{ terminal: AIExecutionResult } | { state: GatingState }> {
  const { timed, pipelineStarted } = fx;
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
  log.info(
    { conversationId: conversation.id, messageId: message.id, workspaceId: params.workspaceId },
    "ai_started"
  );

  // 4. Config + customer + channel page + recent history: independent reads
  // in parallel. History has no dependency on the others — serializing it
  // wasted one full DB round-trip on every single AI turn (critical-path
  // latency). Persona resolution is NOT here: in Hermes external-persona
  // mode no local persona may influence the reply, so it is skipped
  // entirely (no DB read); otherwise it resolves after provider selection.
  const [settingsRaw, customer, channelRow, recentMessagesRaw] = await timed("config", () => Promise.all([
    loadAISettings(db, params.workspaceId),
    db.customer.findUnique({ where: { id: conversation.customerId } }),
    db.channel.findUnique({
      where: { id: conversation.channelId },
      select: { displayName: true, externalId: true },
    }),
    db.message.findMany({
      where: { conversationId: conversation.id, deletedAt: null, isNote: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
      select: { senderType: true, direction: true, text: true },
    }),
  ]));
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
  // and zero order/memory writes. In Hermes external-persona mode no
  // HumanHandoff is created either — the conversation stays OPEN and the
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
      if (!isHermesSelected(settings, process.env.AI_PROVIDER)) {
        const { createHandoff } = await import("@/modules/handoffs/handoff-service");
        await createHandoff(db, {
          workspaceId: params.workspaceId,
          conversationId: conversation.id,
          customerId: customer.id,
          reason: "AI_FAILURE",
          metadata: { messageId: message.id, error: message_text },
          actorUserId: "ai-agent",
        });
      }
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

  // Persona resolution — SKIPPED in Hermes external-persona mode: reply
  // personality is owned by the externally-configured Hermes agent, so no
  // local Persona row, version, or template may influence the reply path.
  // Telemetry carries nulls (never local persona ids) in this mode.
  const hermesPersona = isHermesPersonaMode(provider);
  let persona: PersonaConfig;
  let activePersona: { id: string | null; name: string; source: string; version: number | null };
  if (hermesPersona) {
    persona = {
      name: "Hermes", language: "ar", dialect: null, tone: "external", formality: "external",
      responseLength: "external", emojiLevel: 0, salesStyle: "external",
      systemInstructions: null, prohibitedPhrases: [], customRules: [],
    };
    activePersona = { id: null, name: "Hermes", source: "hermes", version: null };
  } else {
    const resolvedPersona = await timed("persona", () =>
      resolveChannelPersona(db, { workspaceId: params.workspaceId, channelId: conversation.channelId })
    );
    persona = {
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
    activePersona = { id: resolvedPersona.id, name: resolvedPersona.name, source: resolvedPersona.source, version: resolvedPersona.version };
  }
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
      hermesPersona,
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
