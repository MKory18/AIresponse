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
  type ReplyMediaOutcome,
} from "../prompts";
import { wantsMultipleImages } from "@/modules/media/request";
import { validateResponse } from "../guardrails";
import { sendProtectedText } from "../privacy-gate";
import { saveMemories } from "../memory";
import { scrubRecalledText } from "../catalog-boundary";
import { redactSummaryContacts } from "@/modules/orders/draft-service";
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
    catalogBoundary,
    recallGuard,
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
  // اخترعه النموذج ترفضه الـ guardrails. سعر الجملة لا يدخل هنا أبدًا،
  // والكميات كمان: «3 دولار» مش سعر لأن الكمية 3.
  const salesPlan = ext.salesPlan ?? null;
  if (salesPlan) {
    if (salesPlan.primary) {
      allowedNumbers.push(salesPlan.primary.unitPrice, salesPlan.primary.subtotal);
    }
    if (salesPlan.upsell) {
      allowedNumbers.push(salesPlan.upsell.price, salesPlan.upsell.saving);
    }
    for (const c of salesPlan.crossSell) allowedNumbers.push(c.unitPrice);
    if (salesPlan.discount) allowedNumbers.push(salesPlan.discount.discountedPrice, salesPlan.discount.amount);
  }

  // ⚠️ الموديل قال «تمام، ثبّتنا الطلب» والمسودة كانت لسا ناقصة — ولا طلب
  // انسجّل، والزبون انتظر شحنة ما إلها وجود.
  // 🔧 حالة الطلب من منطق الطلب الحتمي: `true` في رقم طلب · `false` المسودة
  // لسا بتتجمع فأي ادعاء تثبيت مرفوض · `undefined` ما في سياق طلب أبدًا
  // (القاعدة مطفية، فردود الأسئلة العادية ما بيتغيّر سلوكها).
  const orderPlaced: boolean | undefined =
    orderResult?.action === "ORDER_CONFIRMED" || orderResult?.action === "ORDER_UPDATED"
      ? true
      : orderResult &&
          ["ASK_MISSING_FIELD", "REQUEST_CONFIRMATION", "DRAFT_UPDATED", "RULES_BLOCKED"].includes(orderResult.action)
        ? false
        : undefined;

  // What really goes out with this reply, decided BEFORE the model writes it:
  // a promised picture that never arrives is worse than no picture.
  const replyMedia = await planReplyMedia(db, {
    workspaceId: params.workspaceId,
    conversationId: conversation.id,
    channelId: conversation.channelId,
    sourceMessageId: message.id,
    customerText: gate.customerText,
    sendMedia: plan.sendMedia,
    productId: context.product?.id ?? null,
  });

  // 10. Response generation (validated by guardrails; regenerate once, then safe fallback).
  // The selected persona drives voice in EVERY provider mode: the external
  // gateway carries no personaId parameter, so the published local
  // instructions travel inside the request via this standard builder.
  const system = [
    coreSystemRules(),
    ...(catalogBoundary ? [catalogBoundary] : []),
    personaPrompt(persona),
    trustedDataPrompt({
      product: context.product
        ? {
            name: context.product.name,
            price: context.product.price,
            currency: context.product.currency ?? "",
            compareAtPrice: context.product.compareAtPrice,
            stockStatus: context.product.stockStatus,
            shortDescription: context.product.shortDescription,
            description: context.product.description,
            ingredients: context.product.ingredients,
            benefits: context.product.benefits,
            usage: context.product.usage,
            warnings: context.product.warnings,
            objections: context.product.objections,
            salesNotes: context.product.salesNotes,
            priceTiers: context.product.priceTiers ?? [],
            compliance: context.product.compliance ?? null,
            faqs: context.product.faqs,
          }
        : undefined,
      knowledge: { faqs: context.knowledge.faqs, documents: context.knowledge.documents },
      media: context.media.map((m) => ({ title: m.title, url: m.url })),
      feedback: plan.useFeedback ? context.feedback : [],
      // Bound memory chars per item so 10 long rows can't bloat every prompt.
      memory: memories
        .map((m) => ({ type: m.type, value: scrubRecalledText(recallGuard, m.value) }))
        .filter((m) => m.value)
        .map((m) => ({
          type: m.type,
          content: m.value.length > 200 ? `${m.value.slice(0, 200)}…` : m.value,
        })),
      summary: scrubRecalledText(recallGuard, conversation.summary) || null,
      // رقم الزبون وعنوانه ما بيوصلوا الموديل — بيوصله إنهم محفوظين بس.
      orderSummary: orderResult?.summaryText ? redactSummaryContacts(orderResult.summaryText) : null,
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
        city: (customer as { city?: string | null }).city ?? null,
        province: (customer as { province?: string | null }).province ?? null,
      },
    }),
  ].join("\n\n");

  const userPrompt = [
    extractionUser,
    `النية: ${extraction.intent} (ثقة ${extraction.confidence})`,
    `الخطة: ${JSON.stringify(plan)}`,
    responseInstruction(persona, { media: replyMedia.outcome }),
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
      orderPlaced,
    });
    if (!check.valid) {
      violations = check.violations;
      log.warn({ violations }, "guardrail_violation_regen");
      // One corrective regeneration — on the model that just answered: after
      // a primary outage the fallback wrote the text, and asking the failing
      // primary again cost a full timeout and then the reply.
      const retry = await timed("responseRegen", () =>
        sendProtectedText(provider, {
          system: `${system}\n\nردك السابق رُفض للأسباب التالية: ${violations.join(", ")}. أعد كتابة الرد ملتزماً تماماً بالقواعد.`,
          user: userPrompt,
          model: effectiveModel,
          temperature: 0.2,
          maxTokens: responseModelCfg.maxTokens,
        }, { pii: customerPII, trustedContacts, allowedNumbers, purpose: "RESPONSE_RETRY" })
      );
      const retryCheck = validateResponse({
        response: retry.text.trim(),
        context,
        prohibitedPhrases: persona.prohibitedPhrases,
        allowFeedbackQuote: plan.useFeedback,
        trustedContacts,
        allowedNumbers,
        orderPlaced,
      });
      if (!retryCheck.valid) {
        throw new AIProviderError(`Guardrail violations persist after retry: ${retryCheck.violations.join(", ")}`);
      }
      responseText = retry.text.trim();
    }
  } catch (err) {
    // AI failure: never fabricate. Keep the message; surface AI_FAILED.
    // NO HumanHandoff record from the AI path — every message stays with the
    // AI and remains reprocessable via job retry under the same idempotency
    // key (no duplicate sends). Error category (TRANSIENT vs PERMANENT)
    // tells operators whether a retry can succeed or configuration must be
    // corrected first — either way the message stays recoverable via job
    // retry + the orphan sweeper.
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
      // P14 — فشل التوليد يُقاس بالمراحل المنجزة حتى لحظة الفشل.
      stageTimings: { ...fx.stageMs, total: Date.now() - pipelineStarted },
    });
    if (!params.dryRun) {
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
      mediaIds: replyMedia.mediaIds,
      mediaSkipped: replyMedia.skipped,
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
      // P14 — حتى الفشل يُقاس: نفس تفصيل المراحل كي لا تُخفى الطلبات الفاشلة.
      stageTimings: { ...fx.stageMs, send: sendMs, total: Date.now() - pipelineStarted },
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
      // P13 — تفصيل المراحل (مفاتيح + أرقام فقط) لحساب P50/P95 لاحقًا.
      stageTimings: { ...fx.stageMs, send: sendMs, total: Date.now() - pipelineStarted },
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

const MAX_IMAGES_PER_REPLY = 3;

interface ReplyMedia {
  mediaIds: string[];
  /** Why no picture goes out; recorded on the row, never silent. */
  skipped?: string;
  /** What the model is told. Undefined when the customer asked for no picture. */
  outcome?: ReplyMediaOutcome;
}

async function planReplyMedia(
  db: Db,
  params: {
    workspaceId: string;
    conversationId: string;
    channelId: string;
    sourceMessageId: string;
    customerText: string;
    sendMedia: boolean;
    productId: string | null;
  }
): Promise<ReplyMedia> {
  if (!params.sendMedia) return { mediaIds: [] };
  if (!params.productId) return { mediaIds: [], skipped: "NO_PRODUCT", outcome: { status: "ASK_PRODUCT" } };
  try {
    const { pickUnsentProductImages } = await import("@/modules/media/service");
    const channel = await db.channel.findUnique({ where: { id: params.channelId }, select: { type: true } });
    const picked = await pickUnsentProductImages(
      db,
      params.workspaceId,
      params.conversationId,
      params.productId,
      wantsMultipleImages(params.customerText) ? MAX_IMAGES_PER_REPLY : 1,
      { channelType: channel?.type, sourceMessageId: params.sourceMessageId }
    );
    if (picked.mediaIds.length > 0) {
      return { mediaIds: picked.mediaIds, outcome: { status: "ATTACHED", count: picked.mediaIds.length } };
    }
    const skipped = picked.skipped ?? "NO_IMAGE";
    const status = skipped === "ALL_SENT" || skipped === "CHANNEL_UNFIT" ? skipped : "NO_IMAGE";
    return { mediaIds: [], skipped, outcome: { status } };
  } catch (err) {
    // The picture is optional; the reply is not.
    log.warn({ conversationId: params.conversationId, error: err instanceof Error ? err.message : "media_pick_failed" }, "media_pick_failed");
    return { mediaIds: [], skipped: "PICK_FAILED", outcome: { status: "UNAVAILABLE" } };
  }
}

async function sendAI(
  db: Db,
  params: { workspaceId: string; conversationId: string; text: string; sourceMessageId?: string; dryRun?: boolean; mediaIds: string[]; mediaSkipped?: string }
) {
  if (params.dryRun) return null;
  const { dispatchOutbound } = await import("@/modules/channels/outbound");
  const sourceMessageId = params.sourceMessageId ?? "n/a";
  // Every photo but the last goes out on its own; the last travels with the
  // words, so the customer reads the text after all the pictures. Each extra
  // has its own idempotency key: a retry skips what already went out.
  const extras = params.mediaIds.slice(0, -1);
  const mediaId = params.mediaIds[params.mediaIds.length - 1];
  for (const extraId of extras) {
    try {
      const extra = await dispatchOutbound(db, {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        sourceMessageId: `${sourceMessageId}:img:${extraId}`,
        text: "",
        mediaId: extraId,
      });
      if (extra.deliveryStatus !== "SENT" && extra.deliveryStatus !== "SKIPPED_DUPLICATE") {
        log.warn({ conversationId: params.conversationId, mediaId: extraId, deliveryStatus: extra.deliveryStatus }, "extra_image_not_sent");
      }
    } catch (err) {
      // One extra photo never costs the customer the reply.
      log.warn({ conversationId: params.conversationId, mediaId: extraId, error: err instanceof Error ? err.message : "send_failed" }, "extra_image_not_sent");
    }
  }
  const result = await dispatchOutbound(db, {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sourceMessageId,
    text: params.text,
    mediaId,
    mediaSkipped: params.mediaSkipped,
  });
  return { id: result.messageId, deliveryStatus: result.deliveryStatus };
}
