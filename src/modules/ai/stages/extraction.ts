/**
 * Pipeline stage 2 — extraction, order intent, plan, handoff policy
 * (P1 split of orchestrator.ts, verbatim logic).
 *
 * Intent + entity extraction (structured, privacy-gated) → injection screen →
 * deterministic order-intent handling → memory + product + RAG context →
 * deterministic response plan → human-review and handoff terminals.
 * Returns a terminal result or the ready state for response generation.
 */
import { childLogger } from "@/core/logger";
import { resolveModel, withRetry, logUsage } from "../router";
import {
  PROMPT_VERSIONS,
  coreSystemRules,
  extractionInstruction,
  wrapUntrustedCustomerContent,
  type Intent,
} from "../prompts";
import { extractionResultSchema, validateStructured, type ExtractionResult, type ResponsePlan } from "../structured";
import { heuristicIntent, looksLikeInjection } from "../intent";
import { saveMemories, loadMemory } from "../memory";
import { buildAIContext } from "../context-builder";
import { wantsMedia } from "@/modules/media/request";
import type { VectorStore } from "@/modules/knowledge/vector-store";
import { PgVectorStore } from "@/modules/knowledge/vector-store";
import { prisma } from "@/core/db/prisma";
import { sendProtectedStructured, extractPhoneDeterministic } from "../privacy-gate";
import { recordAudit } from "@/modules/audit/service";
import { handleOrderIntent } from "@/modules/orders/intelligence";
import { isBuyingContext } from "@/modules/sales/plan-builder";
import type { Db } from "@/modules/customers/service";
import type {
  AIExecutionResult,
  ExtractionReady,
  GatingState,
  OrchestratorDeps,
  PipelineFx,
  PipelineParams,
} from "./state";

const log = childLogger("orchestrator");

export async function runExtraction(
  db: Db,
  params: PipelineParams,
  deps: OrchestratorDeps,
  fx: PipelineFx,
  gate: GatingState
): Promise<{ terminal: AIExecutionResult } | { ready: ExtractionReady }> {
  const { timed, pipelineStarted } = fx;
  const {
    message,
    conversation,
    settings,
    activePersona,
    customer,
    customerText,
    recentMessages,
    customerPII,
    trustedContacts,
    provider,
  } = gate;

  // 5. Intent + entity extraction (structured, repaired, retried, fallback).
  const modelCfg = resolveModel(settings, "EXTRACTION");
  const extractionUser = wrapUntrustedCustomerContent(
    customerText,
    recentMessages.reverse().map((m) => ({
      sender: m.senderType,
      text: m.text ?? "[وسائط]",
    }))
  );
  // Latency: extraction classifies intent/entities only — it does NOT write
  // the customer reply, so the full persona (up to 20,000 chars) must NOT be
  // sent to this call. With long personas this alone removed thousands of
  // tokens from the first of the two serial model round-trips. The RESPONSE
  // call below still receives the complete persona verbatim.
  const extractionSystem = [
    coreSystemRules(),
    extractionInstruction(),
  ].join("\n\n");

  let extraction: ExtractionResult;
  let extractionOk = true;
  // Fast path: trivial greetings skip the extraction LLM call entirely and use
  // the deterministic heuristic (same shape the catch-fallback produces). This
  // removes one full blocking model round-trip for the most common messages
  // without touching order/business logic (greetings never mutate orders).
  const heuristicPre = heuristicIntent(customerText);
  const fastPathGreeting =
    heuristicPre.intent === "GREETING" &&
    customerText.trim().length <= 40 &&
    !looksLikeInjection(customerText);
  try {
    if (fastPathGreeting) {
      extraction = {
        intent: heuristicPre.intent,
        confidence: heuristicPre.confidence,
        entities: {},
        missingFields: [],
        memories: [],
        requestedAction: "ANSWER",
      };
      fx.stageMs.extractionSkipped = 1;
    } else {
      const res = await timed("extraction", () =>
        withRetry(
          () =>
            sendProtectedStructured(provider, {
              system: extractionSystem,
              user: extractionUser,
              model: modelCfg.model,
              temperature: modelCfg.temperature,
              maxTokens: modelCfg.maxTokens,
              validate: (raw) => validateStructured(extractionResultSchema, raw),
            }, { pii: customerPII, trustedContacts, purpose: "EXTRACTION" }),
          { attempts: 2 }
        )
      );
      extraction = res.value;
      // Deterministic authority: the phone regex on the ORIGINAL customer
      // text wins over any model echo (rules decide, the model suggests).
      // Local-only values — never sent anywhere.
      const deterministicPhone = extractPhoneDeterministic(customerText);
      if (deterministicPhone) {
        extraction = {
          ...extraction,
          entities: { ...extraction.entities, phone: deterministicPhone },
        };
      }
      await logUsage(db, {
        workspaceId: params.workspaceId,
        conversationId: conversation.id,
        messageId: message.id,
        purpose: "EXTRACTION",
        provider: provider.name,
        model: modelCfg.model,
        promptVersion: PROMPT_VERSIONS.EXTRACTION,
        personaId: activePersona.id,
        personaVersion: activePersona.version,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        latencyMs: res.latencyMs,
        success: true,
      });
    }
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
      personaId: activePersona.id,
      personaVersion: activePersona.version,
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

  // 6+7. Memory + product resolution are independent — run concurrently.
  // buildAIContext still waits for productId (dependency), but memory no
  // longer blocks product lookup and vice versa.
  // The product candidates are scoped to this page's active catalog: when
  // the workspace holds any catalogs, only the channel's catalog may
  // answer — an unassigned page resolves nothing (safe fallback, said
  // out loud in the UI), and a workspace with no catalogs at all keeps
  // the legacy behaviour byte-for-byte.
  const { resolveCatalogForChannel, catalogProductIds } = await import(
    "@/modules/catalog/service"
  );
  // PERF — resolveCatalogForChannel already short-circuits workspaces with
  // no catalogs internally; the extra workspaceHasCatalogs pre-check here
  // was a duplicate round-trip with identical semantics:
  // no_catalogs → undefined (legacy: every product may answer),
  // assigned+active → ids, otherwise → [] (nothing may answer).
  const resolved = await resolveCatalogForChannel(db, params.workspaceId, conversation.channelId);
  log.info(
    { conversationId: conversation.id, channelId: conversation.channelId, catalog: resolved.status },
    "ai_catalog_resolved"
  );
  const allowedProductIds =
    resolved.status === "ok"
      ? await catalogProductIds(db, params.workspaceId, resolved.catalog.id)
      : resolved.status === "no_catalogs"
        ? undefined
        : [];
  const [memories, productId] = await timed("memoryProduct", () =>
    Promise.all([
      loadMemory(db, params.workspaceId, customer.id),
      resolveProductId(db, params.workspaceId, extraction, customerText, allowedProductIds),
    ])
  );
  const vectorStore = deps.vectorStore ?? getVectorStore();
  const context = await timed("context", () =>
    buildAIContext(db, vectorStore, {
      workspaceId: params.workspaceId,
      query: customerText,
      productId: productId ?? undefined,
      knowledgeLimit: 4,
    })
  );

  // Response model resolved before any terminal decision so HANDOFF/AI_FAILED
  // logs carry the exact runtime model (resolveModel is pure — no side effects).
  const responseModelCfg = resolveModel(settings, "RESPONSE");

  // 8. Deterministic response plan (rules, not generation — spec §17).
  const plan = buildPlan(extraction, context, customerText);
  if (orderResult?.handled && orderResult.action !== "NONE") {
    plan.goal = "complete_order";
    plan.needsClarification = orderResult.action === "ASK_MISSING_FIELD";
    plan.missingFields = orderResult.missingFields ?? plan.missingFields;
  }
  void extractionOk;

  // P8 — Sales Intelligence: خطة بيع حتمية من DB (أسعار/عروض/مكملات) عند
  // سياق شراء. فشلها لا يكسر المسار أبدًا، وغيابها لا يغيّر السلوك القديم.
  let salesPlan: import("@/modules/sales/plan-schemas").SalesPlan | undefined;
  if (productId && isBuyingContext(extraction.intent, extraction.requestedAction)) {
    try {
      // PERF — reuse the product row buildAIContext already read (same row,
      // same workspace check inside buildProductContext). Fallback fetch only
      // if context carries no row (defensive; never expected on this path).
      const fullProduct =
        (context.productRow as Record<string, unknown> | null | undefined) ??
        (await db.product.findUnique({ where: { id: productId } }));
      if (fullProduct && fullProduct.workspaceId === params.workspaceId) {
        const { buildSalesPlan } = await import("@/modules/sales/plan-builder");
        salesPlan = await buildSalesPlan(db, {
          workspaceId: params.workspaceId,
          intent: extraction.intent,
          requestedAction: extraction.requestedAction,
          product: fullProduct as unknown as Record<string, unknown>,
          customerText,
          customerId: customer.id,
          conversationId: conversation.id,
          quantity: extraction.entities.quantity ?? null,
          recordEvents: !params.dryRun,
        });
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : "sales_plan_failed" }, "sales_plan_failed");
    }
  }

  if (orderResult?.needsHumanReview) {
    // Persist any extracted memories before the review alert — never lose facts.
    if (extraction.memories.length && !params.dryRun) {
      await saveMemories(db, {
        workspaceId: params.workspaceId,
        customerId: customer.id,
        source: `ai_extraction:${message.id}`,
        memories: extraction.memories,
      });
    }
    // NO HumanHandoff records, NO HANDOFF terminal — every message gets an AI
    // reply. The order stays blocked by OrderService rules (nothing is
    // confirmed), the block is audit-visible, and the reply still goes out
    // with the selected persona so the conversation stays OPEN.
    if (!params.dryRun) {
      await recordAudit(db, {
        workspaceId: params.workspaceId,
        action: "conversation.review_flagged",
        entityType: "Conversation",
        entityId: conversation.id,
        metadata: { reason: "ORDER_BLOCKED" },
      });
    }
  }

  return {
    ready: {
      extraction,
      orderResult,
      memories,
      context,
      responseModelCfg,
      plan,
      extractionUser,
      salesPlan,
    },
  };
}

async function resolveProductId(
  db: Db,
  workspaceId: string,
  extraction: ExtractionResult,
  customerText = "",
  // The page's catalog, when catalogs exist: undefined = no catalogs in
  // this workspace (legacy: every product may answer); [] = catalogs
  // exist but this page resolves none (nothing may answer).
  allowedIds?: string[] | null
): Promise<string | null> {
  const candidates: string[] = [];
  if (extraction.entities.product) candidates.push(extraction.entities.product);
  // Context-based fallback: match product names against words in the message
  // ("بدي 3" after a product mention resolves via this path).
  for (const word of customerText.split(/[\s،,.!؟?]+/)) {
    if (word.length >= 3) candidates.push(word);
    if (candidates.length >= 12) break;
  }
  if (!candidates.length) return null;
  if (allowedIds && allowedIds.length === 0) return null;
  // Single query instead of N sequential findFirst calls (latency fix).
  const ors: { name: { contains: string } }[] = [];
  for (const name of candidates.slice(0, 12)) {
    ors.push({ name: { contains: name } });
    const cleaned = name.replace(/^(ال|الـ)/, "");
    if (cleaned !== name) ors.push({ name: { contains: cleaned } });
  }
  const product = await db.product.findFirst({
    where: {
      workspaceId,
      isActive: true,
      isArchived: false,
      ...(allowedIds ? { id: { in: allowedIds } } : {}),
      OR: ors,
    },
    select: { id: true },
  });
  return product?.id ?? null;
}

function buildPlan(
  extraction: ExtractionResult,
  context: Awaited<ReturnType<typeof buildAIContext>>,
  customerText = ""
): ResponsePlan {
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
  // The customer's own words AND the extracted entities: «ورجيني ياه»
  // carries no entity, and an entity can match a word never written.
  // Video asks count too — the pipeline answers every visual ask with
  // the product's photo (see selection), never with silence.
  const asked = wantsMedia(customerText);
  const entitiesAsk = /شكل|صورة|صور|كيف يبدو/.test(JSON.stringify(extraction.entities));
  return {
    goal: goalMap[extraction.intent] ?? "clarify",
    needsClarification,
    missingFields: extraction.missingFields,
    sendMedia: asked !== null || entitiesAsk,
    useFeedback: extraction.intent === "FEEDBACK_REQUEST",
    knowledgeSources: ["product", "faq", "policy"],
  };
}

function getVectorStore(): VectorStore {
  return new PgVectorStore((sql, params2) =>
    prisma.$queryRawUnsafe(sql, ...params2) as Promise<Array<Record<string, unknown>>>
  );
}
