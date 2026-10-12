/**
 * Pipeline stage 3 — response generation, guardrails, send, finalize
 * (P1 split of orchestrator.ts, verbatim logic).
 *
 * Prompt assembly (trusted DB data only) → privacy-gated generation →
 * guardrails + one corrective regeneration → AI send → success logging,
 * citations, memory persistence, summary scheduling.
 */
import { childLogger } from "@/core/logger";
import { recordSalesEvent } from "@/modules/sales/metrics";
import { AIProviderError, type AIResponse } from "../provider";
import { withRetry, logUsage, getFallbackModel, executeWithFallback } from "../router";
import {
  PROMPT_VERSIONS,
  coreSystemRules,
  personaPrompt,
  trustedDataPrompt,
  responseInstruction,
  type Intent,
} from "../prompts";
import { validateResponse } from "../guardrails";
import { sendProtectedText } from "../privacy-gate";
import { saveMemories } from "../memory";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import type {
  AIExecutionResult,
  ExtractionReady,
  GatingState,
  PipelineFx,
  PipelineParams,
} from "./state";

const log = childLogger("orchestrator");

export async function runResponse(
  db: Db,
  params: PipelineParams,
  fx: PipelineFx,
  gate: GatingState,
  ext: ExtractionReady
): Promise<AIExecutionResult> {
  const { timed, logTimings, pipelineStarted } = fx;
  const {
    message,
    conversation,
    persona,
    hermesPersona,
    activePersona,
    customer,
    channelRow,
    customerPII,
    trustedContacts,
    provider,
  } = gate;
  const {
    extraction,
    orderResult,
    memories,
    context,
    responseModelCfg,
    plan,
    extractionUser,
  } = ext;

  // P1.1: trusted non-contact numbers that may legitimately appear in the
  // reply (DB prices, order totals) — exempt from contact scrubbing so legit
  // figures are never redacted while invented contacts still are.
  const allowedNumbers: Array<string | number> = [];
  if (context.product) {
    const p = context.product as { price?: string | number | null; compareAtPrice?: string | number | null };
    if (p.price !== undefined && p.price !== null && String(p.price).trim() !== "") allowedNumbers.push(p.price);
    if (p.compareAtPrice !== undefined && p.compareAtPrice !== null && String(p.compareAtPrice).trim() !== "") {
      allowedNumbers.push(p.compareAtPrice);
    }
  }
  const summaryText = orderResult?.summaryText ?? null;
  if (summaryText) {
    for (const m of summaryText.matchAll(/[0-9٠-٩۰-۹][0-9٠-٩۰-۹\s]*/g)) {
      const digits = m[0].replace(/[^0-9٠-٩۰-۹]/g, "");
      if (digits.length >= 7) allowedNumbers.push(m[0].trim());
    }
  }
  // P8 — أرقام خطة البيع (من DB حصرًا) مسموح بها في الرد؛ أي رقم آخر
  // اخترعه النموذج ترفضه الـ guardrails. سعر الجملة لا يدخل هنا أبدًا.
  const salesPlan = ext.salesPlan ?? null;
  if (salesPlan) {
    if (salesPlan.primary) {
      allowedNumbers.push(salesPlan.primary.unitPrice, salesPlan.primary.subtotal, salesPlan.primary.quantity);
    }
    if (salesPlan.upsell) {
      allowedNumbers.push(salesPlan.upsell.price, salesPlan.upsell.saving, salesPlan.upsell.quantity);
    }
    for (const c of salesPlan.crossSell) allowedNumbers.push(c.unitPrice);
    if (salesPlan.discount) allowedNumbers.push(salesPlan.discount.discountedPrice, salesPlan.discount.amount);
  }

  // 10. Response generation (validated by guardrails; regenerate once, then safe fallback).
  // The selected persona drives voice in EVERY provider mode: the external
  // gateway carries no personaId parameter, so the published local
  // instructions travel inside the request via this standard builder.
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
            compliance: context.product.compliance ?? null,
            faqs: context.product.faqs,
          }
        : undefined,
      knowledge: { faqs: context.knowledge.faqs, documents: context.knowledge.documents },
      media: context.media.map((m) => ({ title: m.title, url: m.url })),
      feedback: plan.useFeedback ? context.feedback : [],
      // Bound memory chars per item so 10 long rows can't bloat every prompt.
      memory: memories.map((m) => ({
        type: m.type,
        content: m.value.length > 200 ? `${m.value.slice(0, 200)}…` : m.value,
      })),
      summary: conversation.summary,
      orderSummary: orderResult?.summaryText ?? null,
      sales: salesPlan
        ? {
            primary: salesPlan.primary
              ? { name: salesPlan.primary.name, quantity: salesPlan.primary.quantity, unitPrice: `${salesPlan.primary.unitPrice} ${salesPlan.primary.currency}`, subtotal: String(salesPlan.primary.subtotal) }
              : null,
            offer: salesPlan.upsell
              ? { title: salesPlan.upsell.title, quantity: salesPlan.upsell.quantity, price: `${salesPlan.upsell.price} ${salesPlan.upsell.currency}`, saving: String(salesPlan.upsell.saving) }
              : null,
            crossSell: salesPlan.crossSell.map((c) => ({ name: c.name, price: `${c.unitPrice} ${c.currency}` })),
            objection: salesPlan.objection?.topic ?? null,
            noOfferReason: salesPlan.noOfferReason,
          }
        : undefined,
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
  // P6: explicit opt-in fallback — used ONLY after a retryable primary
  // failure, through the same privacy gate (both calls are sendProtected*).
  // Explicit and telemetry-visible (fallbackUsed): never a hidden substitute.
  const fallbackModel = getFallbackModel(gate.settings);
  let fallbackUsed = false;
  // Tracks whether the fallback model was attempted even when it also
  // fails — the AI_FAILED telemetry below must stay honest about it.
  let fallbackAttempted = false;
  // P6: the recorded model is the one that ACTUALLY generated the text.
  let effectiveModel = responseModelCfg.model;
  let res: AIResponse | undefined;
  try {
    const gen = (model: string, temperature: number, maxTokens: number) =>
      withRetry(
        () =>
          sendProtectedText(provider, {
            system,
            user: userPrompt,
            model,
            temperature,
            maxTokens,
          }, { pii: customerPII, trustedContacts, allowedNumbers, purpose: "RESPONSE" }),
        { attempts: 2 }
      );
    const run = () =>
      timed("responseGen", () => gen(responseModelCfg.model, responseModelCfg.temperature, responseModelCfg.maxTokens));
    if (fallbackModel && fallbackModel !== responseModelCfg.model) {
      const out = await executeWithFallback(run, {
        fallbackModel,
        runFallback: (m) => {
          fallbackAttempted = true;
          return timed("responseFallback", () => gen(m, responseModelCfg.temperature, responseModelCfg.maxTokens));
        },
      });
      res = out.result;
      fallbackUsed = out.fallbackUsed;
    } else {
      res = await run();
    }
    responseText = res.text.trim();
    if (!responseText) {
      throw new AIProviderError("Model returned an empty response");
    }
    effectiveModel = fallbackUsed && fallbackModel ? fallbackModel : responseModelCfg.model;
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
      trustedContacts,
      allowedNumbers,
    });
    if (!check.valid) {
      violations = check.violations;
      log.warn({ violations }, "guardrail_violation_regen");
      // One corrective regeneration.
      const retry = await sendProtectedText(provider, {
        system: `${system}\n\nردك السابق رُفض للأسباب التالية: ${violations.join(", ")}. أعد كتابة الرد ملتزماً تماماً بالقواعد.`,
        user: userPrompt,
        model: responseModelCfg.model,
        temperature: 0.2,
        maxTokens: responseModelCfg.maxTokens,
      }, { pii: customerPII, trustedContacts, allowedNumbers, purpose: "RESPONSE_RETRY" });
      const retryCheck = validateResponse({
        response: retry.text.trim(),
        context,
        prohibitedPhrases: persona.prohibitedPhrases,
        allowFeedbackQuote: plan.useFeedback,
        trustedContacts,
        allowedNumbers,
      });
      if (!retryCheck.valid) {
        throw new AIProviderError(`Guardrail violations persist after retry: ${retryCheck.violations.join(", ")}`);
      }
      responseText = retry.text.trim();
    }
  } catch (err) {
    // AI failure: never fabricate. Keep the message; surface AI_FAILED.
    // External-provider path (Hermes): NO HumanHandoff record — activating a
    // persona must not reintroduce automatic handoffs. The conversation stays
    // OPEN and the failure is reprocessable via job retry under the same
    // idempotency key (no duplicate sends).
    // Record usage + create a visible handoff so the failure never disappears.
    // Error category (TRANSIENT vs PERMANENT) tells operators whether a retry
    // can succeed or configuration must be corrected first — either way the
    // message stays recoverable via job retry + the orphan sweeper.
    const retryable = err instanceof AIProviderError ? err.retryable : true;
    const rawMessage = err instanceof AIProviderError ? err.message : String(err);
    const categorized = `${retryable ? "TRANSIENT" : "PERMANENT"}: ${rawMessage}`;
    log.warn(
      {
        conversationId: conversation.id,
        messageId: message.id,
        retryable,
        httpStatus: err instanceof AIProviderError ? err.httpStatus : undefined,
      },
      "ai_failed"
    );
    await logUsage(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      purpose: "RESPONSE",
      provider: provider.name,
      model: responseModelCfg.model,
      intent: extraction.intent,
      promptVersion: PROMPT_VERSIONS.RESPONSE,
      personaId: activePersona.id,
      personaVersion: activePersona.version,
      // Honest even when the fallback also failed (attempted, not completed).
      fallbackUsed: fallbackUsed || fallbackAttempted,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      success: false,
      status: "AI_FAILED",
      error: categorized,
    });
    if (!params.dryRun) {
      if (!hermesPersona) {
        const { createHandoff } = await import("@/modules/handoffs/handoff-service");
        await createHandoff(db, {
          workspaceId: params.workspaceId,
          conversationId: conversation.id,
          customerId: customer.id,
          reason: "AI_FAILURE",
          metadata: { messageId: message.id, error: err instanceof Error ? err.message : String(err) },
          actorUserId: "ai-agent",
        });
      }
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
      // Categorized so job lastError + sweeper logs tell operators whether a
      // retry can succeed (TRANSIENT) or config must be fixed (PERMANENT).
      error: categorized,
    };
  }

  // 11. Persist: send as AI + citations + memory.
  // A failed/queued send is NEVER reported as success: return AI_FAILED so
  // the job queue retries (same idempotency key reuses the row — no duplicate).
  const sendStarted = Date.now();
  // Critical path: the reply enters outbound immediately; analytics, citations,
  // memory writes and summaries all happen AFTER (never block the send).
  const sent = await timed("send", () =>
    sendAI(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      text: responseText,
      sourceMessageId: message.id,
      dryRun: params.dryRun,
      sendMedia: plan.sendMedia,
      productId: context.product?.id ?? null,
    })
  );
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
      personaId: activePersona.id,
      personaVersion: activePersona.version,
      fallbackUsed,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: sendMs,
      success: false,
      status: "AI_FAILED",
      error: `${sent.deliveryStatus === "QUEUED" ? "TRANSIENT" : "PERMANENT"}: Outbound delivery ${sent.deliveryStatus}`,
    });
    logTimings("AI_FAILED", { reason: `Outbound delivery ${sent.deliveryStatus}` });
    return {
      status: "AI_FAILED",
      intent: extraction.intent as Intent,
      confidence: extraction.confidence,
      plan,
      error: `${sent.deliveryStatus === "QUEUED" ? "TRANSIENT" : "PERMANENT"}: Outbound delivery ${sent.deliveryStatus}`,
    };
  }

  // The reply is on its way (or was already sent): now record success,
  // citations, and memories.
  // PERF — these terminal writes are mutually independent (separate tables,
  // reply already sent), so they run concurrently instead of holding the
  // worker slot through N sequential round-trips. allSettled lets every
  // write finish; the first error still propagates exactly as before.
  // P8 — OFFER_SHOWN يُسجَّل فقط بعد وصول الرد فعليًا (اقتراح ≠ أُرسل).
  const postSendTasks: Promise<unknown>[] = [];
  if (salesPlan?.upsell && !params.dryRun) {
    postSendTasks.push(
      recordSalesEvent(db, {
        workspaceId: params.workspaceId,
        type: "OFFER_SHOWN",
        conversationId: conversation.id,
        customerId: customer.id,
        productId: salesPlan.upsell.productId,
        sku: salesPlan.upsell.sku,
        value: salesPlan.upsell.saving,
        payload: { title: salesPlan.upsell.title, quantity: salesPlan.upsell.quantity, price: salesPlan.upsell.price },
      }).catch(() => {})
    );
  }
  postSendTasks.push(
    logUsage(db, {
      workspaceId: params.workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      purpose: "RESPONSE",
      provider: provider.name,
      model: effectiveModel,
      intent: extraction.intent,
      confidence: extraction.confidence,
      promptVersion: PROMPT_VERSIONS.RESPONSE,
      personaId: activePersona.id,
      personaVersion: activePersona.version,
      fallbackUsed,
      promptTokens: responseTokens.promptTokens,
      completionTokens: responseTokens.completionTokens,
      latencyMs: responseTokens.latencyMs,
      success: true,
    })
  );

  if (!params.dryRun) {
    postSendTasks.push(
      db.knowledgeCitation.createMany({
        data: context.citations.map((c) => ({
          workspaceId: params.workspaceId,
          conversationId: conversation.id,
          messageId: message.id,
          sourceType: c.sourceType,
          sourceId: c.sourceId,
        })),
        skipDuplicates: true,
      })
    );
  }

  if (extraction.memories.length && !params.dryRun) {
    postSendTasks.push(
      saveMemories(db, {
        workspaceId: params.workspaceId,
        customerId: customer.id,
        source: `ai_extraction:${message.id}`,
        memories: extraction.memories,
      })
    );
  }

  // 12. Summary refresh at intervals (not every message).
  postSendTasks.push(
    (async () => {
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
    })()
  );

  const settled = await Promise.allSettled(postSendTasks);
  for (const s of settled) {
    if (s.status === "rejected") throw s.reason;
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
  logTimings(plan.needsClarification ? "CLARIFIED" : "RESPONDED", { intent: extraction.intent });
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

async function sendAI(
  db: Db,
  params: { workspaceId: string; conversationId: string; text: string; sourceMessageId?: string; dryRun?: boolean; sendMedia?: boolean; productId?: string | null }
) {
  if (params.dryRun) return null;
  const { dispatchOutbound } = await import("@/modules/channels/outbound");
  let mediaId: string | null = null;
  let mediaSkipped: string | undefined;
  if (params.sendMedia && params.productId) {
    const { pickUnsentProductImage } = await import("@/modules/media/service");
    const picked = await pickUnsentProductImage(db, params.workspaceId, params.conversationId, params.productId);
    if (picked.skipped) {
      // Prepared and refused before anything leaves: no image at all is
      // better than the wrong one, a repeat, or one the channel refuses.
      mediaSkipped = picked.skipped;
    } else {
      mediaId = picked.mediaId;
    }
  }
  const result = await dispatchOutbound(db, {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sourceMessageId: params.sourceMessageId ?? "n/a",
    text: params.text,
    mediaId: mediaId ?? undefined,
    mediaSkipped,
  });
  return { id: result.messageId, deliveryStatus: result.deliveryStatus };
}
