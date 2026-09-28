import { childLogger } from "@/core/logger";
import type { MessageType } from "@prisma/client";
import type { Db } from "@/modules/customers/service";
import { NotFoundError } from "@/core/errors";
import { getAIProvider, AIProviderError, type AIProvider } from "./provider";
import { loadAISettings, resolveModel, withRetry, logUsage, type AISettingsLike } from "./router";
import {
  PROMPT_VERSIONS, coreSystemRules, personaPrompt, trustedDataPrompt,
  wrapUntrustedCustomerContent, extractionInstruction, responseInstruction,
  type PersonaConfig, type Intent,
} from "./prompts";
import { extractionResultSchema, validateStructured, type ExtractionResult, type ResponsePlan } from "./structured";
import { heuristicIntent, looksLikeInjection } from "./intent";
import { saveMemories, loadMemory } from "./memory";
import { resolveChannelPersona } from "./channel-persona";
import { buildAIContext } from "./context-builder";
import type { VectorStore } from "@/modules/knowledge/vector-store";
import { validateResponse } from "./guardrails";
import { recordAudit } from "@/modules/audit/service";

import { PgVectorStore } from "@/modules/knowledge/vector-store";
import { prisma } from "@/core/db/prisma";
import { handleOrderIntent } from "@/modules/orders/intelligence";

const log = childLogger("orchestrator");

export interface AIExecutionResult {
  status: "RESPONDED" | "CLARIFIED" | "HANDOFF" | "SKIPPED" | "AI_DISABLED" | "AI_FAILED" | "DUPLICATE" | "NOT_INBOUND";
  intent?: Intent;
  confidence?: number;
  plan?: ResponsePlan;
  response?: string;
  citations?: { sourceType: string; sourceId: string }[];
  violations?: string[];
  executionId?: string;
  error?: string;
  /** Page-resolved AI persona driving this execution (channel → workspace). */
  persona?: { id: string | null; name: string; source: string };
}

export interface OrchestratorDeps {
  provider?: AIProvider;
  vectorStore?: VectorStore;
}

/**
 * AIOrchestrator.process — the central pipeline:
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
  // 1. Load message — only inbound customer messages drive the AI.
  const message = await db.message.findUnique({ where: { id: params.messageId } });
  if (!message || message.workspaceId !== params.workspaceId || message.conversationId !== params.conversationId) {
    return { status: "SKIPPED" };
  }
  if (message.direction !== "INBOUND" || message.senderType !== "CUSTOMER") {
    return { status: "NOT_INBOUND" }; // AI loop prevention
  }

  // 2. Idempotency: one successful AI execution per message (failed runs are
  // retried by the job queue and must not be blocked).
  // 3. Conversation state gating (+ soft-deleted threads never run AI).
  // Independent reads run in parallel to cut latency without losing safety.
  const [existing, conversation] = await Promise.all([
    db.aIUsageLog.findFirst({
      where: { messageId: message.id, purpose: "RESPONSE", status: "SUCCESS" },
      select: { id: true },
    }),
    db.conversation.findUnique({ where: { id: params.conversationId } }),
  ]);
  if (existing && !params.dryRun) return { status: "DUPLICATE", executionId: existing.id };
  if (!conversation || conversation.workspaceId !== params.workspaceId) throw new NotFoundError("Conversation");
  if ((conversation as { deletedAt?: Date | null }).deletedAt) return { status: "SKIPPED" };
  if (!conversation.aiEnabled || conversation.aiState !== "AI_ACTIVE") {
    if (!params.dryRun) return { status: "AI_DISABLED" };
  }

  // 4. Config + persona (page-assigned → workspace default) + customer +
  // channel page: independent reads in parallel.
  const [settingsRaw, resolvedPersona, customer, channelRow] = await Promise.all([
    loadAISettings(db, params.workspaceId),
    resolveChannelPersona(db, { workspaceId: params.workspaceId, channelId: conversation.channelId }),
    db.customer.findUnique({ where: { id: conversation.customerId } }),
    db.channel.findUnique({
      where: { id: conversation.channelId },
      select: { displayName: true, externalId: true },
    }),
  ]);
  const settings = settingsRaw as AISettingsLike | null;
  if (settings && !settings.aiEnabled) return { status: "AI_DISABLED" };
  if (settings && settings.autoRespond === false && !params.dryRun) return { status: "AI_DISABLED" };
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
  const activePersona = { id: resolvedPersona.id, name: resolvedPersona.name, source: resolvedPersona.source };
  if (!customer) throw new NotFoundError("Customer");

  // Fail-closed: a misconfigured real provider must never produce fake
  // replies. Surface AI_FAILED (job retry + handoff + audit) with zero
  // outbound sends and zero order/memory writes.
  let provider: AIProvider;
  try {
    provider = deps.provider ?? getAIProvider();
  } catch (err) {
    const message_text = err instanceof Error ? err.message : String(err);
    log.error({ err: message_text, conversationId: conversation.id }, "ai_provider_not_configured");
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
        error: message_text,
      });
      const { createHandoff } = await import("@/modules/handoffs/handoff-service");
      await createHandoff(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        customerId: customer.id,
        reason: "AI_FAILURE",
        metadata: { messageId: message.id, error: message_text },
        actorUserId: "ai-agent",
      });
      await recordAudit(db, {
        workspaceId: params.workspaceId,
        action: "conversation.ai_failed",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { reason: "AI_NOT_CONFIGURED" },
      });
    }
    return { status: "AI_FAILED", error: message_text };
  }
  const customerText = message.text ?? "[رسالة وسائط]";
  const recentMessages = await db.message.findMany({
    where: { conversationId: conversation.id, deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 8,
    select: { senderType: true, direction: true, text: true },
  });

  // 5. Intent + entity extraction (structured, repaired, retried, fallback).
  const modelCfg = resolveModel(settings, "EXTRACTION");
  const extractionUser = wrapUntrustedCustomerContent(
    customerText,
    recentMessages.reverse().map((m) => ({
      sender: m.senderType,
      text: m.text ?? "[وسائط]",
    }))
  );
  const extractionSystem = [
    coreSystemRules(),
    personaPrompt(persona),
    extractionInstruction(),
  ].join("\n\n");

  let extraction: ExtractionResult;
  let extractionOk = true;
  try {
    const res = await withRetry(
      () =>
        provider.generateStructured<ExtractionResult>({
          system: extractionSystem,
          user: extractionUser,
          model: modelCfg.model,
          temperature: modelCfg.temperature,
          maxTokens: modelCfg.maxTokens,
          validate: (raw) => validateStructured(extractionResultSchema, raw),
        }),
      { attempts: 2 }
    );
    extraction = res.value;
    await logUsage(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      purpose: "EXTRACTION",
      provider: provider.name,
      model: modelCfg.model,
      promptVersion: PROMPT_VERSIONS.EXTRACTION,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      latencyMs: res.latencyMs,
      success: true,
    });
  } catch (err) {
    extractionOk = false;
    const fallback = heuristicIntent(customerText);
    extraction = {
      intent: fallback.intent,
      confidence: fallback.confidence,
      entities: {},
      missingFields: [],
      memories: [],
      requestedAction: fallback.intent === "HUMAN_REQUEST" ? "HANDOFF_HUMAN" : "ANSWER",
    };
    await logUsage(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      purpose: "EXTRACTION",
      provider: provider.name,
      model: modelCfg.model,
      promptVersion: PROMPT_VERSIONS.EXTRACTION,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Injection defence: customer content never escalates or changes policy.
  const injection = looksLikeInjection(customerText);

  // Order Intelligence: deterministic draft/rules handling for order intents.
  let orderResult: Awaited<ReturnType<typeof handleOrderIntent>> | null = null;
  if (
    ["ORDER_CREATE", "ORDER_UPDATE", "ORDER_CANCEL", "UNKNOWN"].includes(extraction.intent) ||
    extraction.requestedAction === "CREATE_ORDER"
  ) {
    try {
      orderResult = await handleOrderIntent(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        customerId: customer.id,
        extraction,
        customerText,
        source: "AI",
        actorUserId: "ai-agent",
      });
    } catch (err) {
      log.error({ err }, "order_intelligence_failed");
    }
  }

  // 6. Memory (load before context, save curated candidates after).
  const memories = await loadMemory(db, params.workspaceId, customer.id);

  // 7. Context per intent (Phase 3 buildAIContext — bounded retrieval).
  const productId = await resolveProductId(db, params.workspaceId, extraction, customerText);
  const vectorStore = deps.vectorStore ?? getVectorStore();
  const context = await buildAIContext(db, vectorStore, {
    workspaceId: params.workspaceId,
    query: customerText,
    productId: productId ?? undefined,
    knowledgeLimit: 4,
  });

  // 8. Deterministic response plan (rules, not generation — spec §17).
  const plan = buildPlan(extraction, context);
  if (orderResult?.handled && orderResult.action !== "NONE") {
    plan.goal = "complete_order";
    plan.needsClarification = orderResult.action === "ASK_MISSING_FIELD";
    plan.missingFields = orderResult.missingFields ?? plan.missingFields;
  }
  void extractionOk;

  if (orderResult?.needsHumanReview) {
    // Persist any extracted memories before handing off — never lose facts.
    if (extraction.memories.length && !params.dryRun) {
      await saveMemories(db, {
        workspaceId: params.workspaceId,
        customerId: customer.id,
        source: `ai_extraction:${message.id}`,
        memories: extraction.memories,
      });
    }
    const { createHandoff } = await import("@/modules/handoffs/handoff-service");
    if (!params.dryRun) {
      await createHandoff(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        customerId: customer.id,
        reason: "ORDER_BLOCKED",
        metadata: { messageId: message.id, confidence: extraction.confidence },
        actorUserId: "ai-agent",
      });
      // State machine: review alert only — the thread stays AI_ACTIVE.
      // Ownership changes exclusively via manual takeover.
      await recordAudit(db, {
        workspaceId: params.workspaceId,
        action: "conversation.review_requested",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { reason: "ORDER_REQUIRES_HUMAN" },
      });
    }
    return {
      status: "HANDOFF",
      intent: extraction.intent as Intent,
      confidence: extraction.confidence,
      plan,
      response: undefined,
      persona: activePersona,
    };
  }

  // 9. Handoff policy.
  const handoffThreshold = settings?.humanHandoffThreshold ?? 0.5;
  const mustHandoff =
    injection ||
    extraction.requestedAction === "HANDOFF_HUMAN" ||
    extraction.intent === "HUMAN_REQUEST" ||
    extraction.intent === "COMPLAINT" ||
    extraction.confidence < handoffThreshold;

  if (mustHandoff && !params.dryRun) {
    // Save memories even on handoff turns — complaints/requests carry facts.
    if (extraction.memories.length) {
      await saveMemories(db, {
        workspaceId: params.workspaceId,
        customerId: customer.id,
        source: `ai_extraction:${message.id}`,
        memories: extraction.memories,
      });
    }
    const { createHandoff } = await import("@/modules/handoffs/handoff-service");
    const handoffReasonMap: Record<string, "INJECTION_DETECTED" | "COMPLAINT" | "CUSTOMER_REQUEST" | "LOW_CONFIDENCE"> = {
      PROMPT_INJECTION: "INJECTION_DETECTED",
      COMPLAINT: "COMPLAINT",
      CUSTOMER_REQUEST: "CUSTOMER_REQUEST",
      LOW_CONFIDENCE: "LOW_CONFIDENCE",
    };
    await createHandoff(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      customerId: customer.id,
      reason: handoffReasonMap[handoffReason(extraction, injection)] ?? "LOW_CONFIDENCE",
      metadata: { messageId: message.id, confidence: extraction.confidence },
      actorUserId: "ai-agent",
    });
    await recordAudit(db, {
      workspaceId: params.workspaceId,
      action: "conversation.review_requested",
      entityType: "Conversation",
      entityId: conversation.id,
      metadata: { reason: handoffReason(extraction, injection), intent: extraction.intent, confidence: extraction.confidence },
    });
    // Handoff is an alert/review request only — NO auto-reply to customer.
    // Human agent will respond manually.
    return {
      status: "HANDOFF",
      intent: extraction.intent as Intent,
      confidence: extraction.confidence,
      plan,
      response: undefined,
      persona: activePersona,
    };
  }

  // 10. Response generation (validated by guardrails; regenerate once, then safe fallback).
  const responseModelCfg = resolveModel(settings, "RESPONSE");
  const system = [
    coreSystemRules(),
    personaPrompt(persona),
    trustedDataPrompt({
      product: context.product
        ? {
            name: context.product.name,
            price: `${context.product.price} ${context.product.currency ?? ""}`.trim(),
            currency: context.product.currency ?? "",
            stockStatus: context.product.stockStatus,
            shortDescription: context.product.shortDescription,
            benefits: context.product.benefits,
            usage: context.product.usage,
            warnings: context.product.warnings,
            objections: context.product.objections,
            salesNotes: context.product.salesNotes,
            faqs: context.product.faqs,
          }
        : undefined,
      knowledge: { faqs: context.knowledge.faqs, documents: context.knowledge.documents },
      media: context.media.map((m) => ({ title: m.title, url: m.url })),
      feedback: plan.useFeedback ? context.feedback : [],
      memory: memories.map((m) => ({ type: m.type, content: m.value })),
      summary: conversation.summary,
      orderSummary: orderResult?.summaryText ?? null,
      customer: {
        name: (customer as { name?: string | null }).name ?? null,
        page: channelRow?.displayName ?? null,
      },
    }),
  ].join("\n\n");

  const userPrompt = [
    extractionUser,
    `النية: ${extraction.intent} (ثقة ${extraction.confidence})`,
    `الخطة: ${JSON.stringify(plan)}`,
    responseInstruction(persona),
  ].join("\n\n");

  let responseText = "";
  let violations: string[] = [];
  let responseTokens = { promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  try {
    const res = await withRetry(
      () =>
        provider.generateText({
          system,
          user: userPrompt,
          model: responseModelCfg.model,
          temperature: responseModelCfg.temperature,
          maxTokens: responseModelCfg.maxTokens,
        }),
      { attempts: 2 }
    );
    responseText = res.text.trim();
    if (!responseText) {
      throw new AIProviderError("Model returned an empty response");
    }
    responseTokens = {
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      latencyMs: res.latencyMs,
    };
    // NOTE: RESPONSE success is logged only AFTER the outbound send succeeds
    // (below) — logging it here would poison DUPLICATE idempotency and turn
    // every send-failure retry into a false DUPLICATE skip.

    // Guardrails
    const check = validateResponse({
      response: responseText,
      context,
      prohibitedPhrases: persona.prohibitedPhrases,
      allowFeedbackQuote: plan.useFeedback,
    });
    if (!check.valid) {
      violations = check.violations;
      log.warn({ violations }, "guardrail_violation_regen");
      // One corrective regeneration.
      const retry = await provider.generateText({
        system: `${system}\n\nردك السابق رُفض للأسباب التالية: ${violations.join(", ")}. أعد كتابة الرد ملتزماً تماماً بالقواعد.`,
        user: userPrompt,
        model: responseModelCfg.model,
        temperature: 0.2,
        maxTokens: responseModelCfg.maxTokens,
      });
      const retryCheck = validateResponse({
        response: retry.text.trim(),
        context,
        prohibitedPhrases: persona.prohibitedPhrases,
        allowFeedbackQuote: plan.useFeedback,
      });
      if (!retryCheck.valid) {
        throw new AIProviderError(`Guardrail violations persist after retry: ${retryCheck.violations.join(", ")}`);
      }
      responseText = retry.text.trim();
    }
  } catch (err) {
    // AI failure: never fabricate. Keep the message; surface AI_FAILED.
    // Record usage + create a visible handoff so the failure never disappears.
    await logUsage(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      purpose: "RESPONSE",
      provider: provider.name,
      model: responseModelCfg.model,
      intent: extraction.intent,
      promptVersion: PROMPT_VERSIONS.RESPONSE,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      success: false,
      status: "AI_FAILED",
      error: err instanceof AIProviderError ? err.message : String(err),
    });
    if (!params.dryRun) {
      const { createHandoff } = await import("@/modules/handoffs/handoff-service");
      await createHandoff(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        customerId: customer.id,
        reason: "AI_FAILURE",
        metadata: { messageId: message.id, error: err instanceof Error ? err.message : String(err) },
        actorUserId: "ai-agent",
      });
      // State machine: alert only — the thread stays AI_ACTIVE so the next
      // inbound (or job retry) is processed by AI again. Ownership changes
      // exclusively via manual takeover.
      await recordAudit(db, {
        workspaceId: params.workspaceId,
        action: "conversation.ai_failed",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { reason: "AI_FAILED" },
      });
    }
    return {
      status: "AI_FAILED",
      intent: extraction.intent as Intent,
      confidence: extraction.confidence,
      plan,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 11. Persist: send as AI + citations + memory.
  // A failed/queued send is NEVER reported as success: return AI_FAILED so
  // the job queue retries (same idempotency key reuses the row — no duplicate).
  const sendStarted = Date.now();
  const sent = await sendAI(db, {
    workspaceId: params.workspaceId,
    conversationId: conversation.id,
    text: responseText,
    sourceMessageId: message.id,
    dryRun: params.dryRun,
    sendMedia: plan.sendMedia,
    productId: context.product?.id ?? null,
  });
  const sendMs = Date.now() - sendStarted;
  if (sent && sent.deliveryStatus !== "SENT" && sent.deliveryStatus !== "SKIPPED_DUPLICATE") {
    log.warn(
      { conversationId: conversation.id, messageId: message.id, deliveryStatus: sent.deliveryStatus, sendMs },
      "ai_send_failed"
    );
    await logUsage(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      purpose: "RESPONSE",
      provider: provider.name,
      model: responseModelCfg.model,
      intent: extraction.intent,
      confidence: extraction.confidence,
      promptVersion: PROMPT_VERSIONS.RESPONSE,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: sendMs,
      success: false,
      status: "AI_FAILED",
      error: `Outbound delivery ${sent.deliveryStatus}`,
    });
    return {
      status: "AI_FAILED",
      intent: extraction.intent as Intent,
      confidence: extraction.confidence,
      plan,
      error: `Outbound delivery ${sent.deliveryStatus}`,
    };
  }

  // The reply is on its way (or was already sent): now record success,
  // citations, and memories.
  await logUsage(db, {
    workspaceId: params.workspaceId,
    conversationId: conversation.id,
    messageId: message.id,
    purpose: "RESPONSE",
    provider: provider.name,
    model: responseModelCfg.model,
    intent: extraction.intent,
    confidence: extraction.confidence,
    promptVersion: PROMPT_VERSIONS.RESPONSE,
    promptTokens: responseTokens.promptTokens,
    completionTokens: responseTokens.completionTokens,
    latencyMs: responseTokens.latencyMs,
    success: true,
  });

  if (!params.dryRun) {
    await db.knowledgeCitation.createMany({
      data: context.citations.map((c) => ({
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        messageId: message.id,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
      })),
      skipDuplicates: true,
    });
  }

  if (extraction.memories.length && !params.dryRun) {
    await saveMemories(db, {
      workspaceId: params.workspaceId,
      customerId: customer.id,
      source: `ai_extraction:${message.id}`,
      memories: extraction.memories,
    });
  }

  // 12. Summary refresh at intervals (not every message).
  const inboundCount = await db.message.count({
    where: { conversationId: conversation.id, direction: "INBOUND", deletedAt: null },
  });
  if (inboundCount % 6 === 0 && !params.dryRun) {
    await db.backgroundJob.create({
      data: {
        type: "generate_summary",
        workspaceId: params.workspaceId,
        payload: { conversationId: conversation.id } as never,
      },
    });
  }

  log.info(
    {
      conversationId: conversation.id,
      messageId: message.id,
      intent: extraction.intent,
      pipelineMs: Date.now() - pipelineStarted,
    },
    "ai_pipeline_completed"
  );
  return {
    status: plan.needsClarification ? "CLARIFIED" : "RESPONDED",
    intent: extraction.intent as Intent,
    confidence: extraction.confidence,
    plan,
    response: responseText,
    citations: context.citations,
    violations: violations.length ? violations : undefined,
    executionId: sent?.id,
    persona: activePersona,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveProductId(db: Db, workspaceId: string, extraction: ExtractionResult, customerText = ""): Promise<string | null> {
  const candidates: string[] = [];
  if (extraction.entities.product) candidates.push(extraction.entities.product);
  // Context-based fallback: match product names against words in the message
  // ("بدي 3" after a product mention resolves via this path).
  for (const word of customerText.split(/[\s،,.!؟?]+/)) {
    if (word.length >= 3) candidates.push(word);
  }
  for (const name of candidates) {
    const cleaned = name.replace(/^(ال|الـ)/, "");
    const product = await db.product.findFirst({
      where: {
        workspaceId,
        isActive: true,
        isArchived: false,
        OR: [{ name: { contains: name } }, ...(cleaned !== name ? [{ name: { contains: cleaned } }] : [])],
      },
      select: { id: true },
    });
    if (product) return product.id;
  }
  return null;
}

function buildPlan(extraction: ExtractionResult, context: Awaited<ReturnType<typeof buildAIContext>>): ResponsePlan {
  const goalMap: Record<string, string> = {
    GREETING: "greet",
    PRODUCT_QUESTION: "answer_product",
    PRICE_QUESTION: "answer_price",
    AVAILABILITY: "answer_product",
    PRODUCT_COMPARISON: "answer_product",
    HOW_TO_USE: "answer_usage",
    BENEFITS: "answer_usage",
    FEEDBACK_REQUEST: "answer_feedback",
    DELIVERY_QUESTION: "answer_delivery",
    PAYMENT_QUESTION: "answer_payment",
    RETURN_REQUEST: "answer_policy",
    ORDER_CREATE: "complete_order",
    ORDER_UPDATE: "clarify",
    ORDER_CANCEL: "handoff",
    TRACK_ORDER: "track_order",
    HUMAN_REQUEST: "handoff",
    COMPLAINT: "handle_complaint",
    UNKNOWN: "clarify",
  };
  const needsClarification =
    extraction.requestedAction === "CLARIFY" ||
    (extraction.intent === "ORDER_CREATE" && extraction.missingFields.length > 0) ||
    extraction.intent === "UNKNOWN";
  return {
    goal: goalMap[extraction.intent] ?? "clarify",
    needsClarification,
    missingFields: extraction.missingFields,
    sendMedia: /شكل|صورة|صور|كيف يبدو/.test(JSON.stringify(extraction.entities)),
    useFeedback: extraction.intent === "FEEDBACK_REQUEST",
    knowledgeSources: ["product", "faq", "policy"],
  };
}

function handoffReason(extraction: ExtractionResult, injection: boolean): string {
  if (injection) return "PROMPT_INJECTION";
  if (extraction.intent === "COMPLAINT") return "COMPLAINT";
  if (extraction.intent === "HUMAN_REQUEST") return "CUSTOMER_REQUEST";
  if (extraction.requestedAction === "HANDOFF_HUMAN") return "CUSTOMER_REQUEST";
  return "LOW_CONFIDENCE";
}

async function sendAI(
  db: Db,
  params: { workspaceId: string; conversationId: string; text: string; sourceMessageId?: string; dryRun?: boolean; sendMedia?: boolean; productId?: string | null }
) {
  if (params.dryRun) return null;
  const { dispatchOutbound } = await import("@/modules/channels/outbound");
  let mediaId: string | null = null;
  if (params.sendMedia && params.productId) {
    const { findProductMedia } = await import("@/modules/media/service");
    const media = await findProductMedia(db, params.workspaceId, params.productId, 1);
    if (media.length > 0) mediaId = media[0].id;
  }
  const result = await dispatchOutbound(db, {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sourceMessageId: params.sourceMessageId ?? "n/a",
    text: params.text,
    mediaId: mediaId ?? undefined,
  });
  return { id: result.messageId, deliveryStatus: result.deliveryStatus };
}

function getVectorStore(): VectorStore {
  return new PgVectorStore((sql, params2) =>
    prisma.$queryRawUnsafe(sql, ...params2) as Promise<Array<Record<string, unknown>>>
  );
}
