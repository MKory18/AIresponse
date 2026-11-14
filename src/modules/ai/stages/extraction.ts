/**
 * Pipeline stage 2 — extraction, order intent, plan, handoff policy
 * (P1 split of orchestrator.ts, verbatim logic).
 *
 * Intent + entity extraction (structured, privacy-gated) → injection screen →
 * deterministic order-intent handling → memory + product + RAG context →
 * deterministic response plan → human-review and handoff terminals.
 * Returns a terminal result or the ready state for response generation.
 */
import { pickBestProductMatch, productSearchWords } from "@/modules/ai/product-match";
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
import { buildCatalogBoundary, loadRecallGuard, scrubRecalledHistory } from "../catalog-boundary";
import { wantsMedia } from "@/modules/media/request";
import { searchKnowledgeChunks } from "@/modules/knowledge/retriever";
import type { VectorStore } from "@/modules/knowledge/vector-store";
import { PgVectorStore } from "@/modules/knowledge/vector-store";
import { prisma } from "@/core/db/prisma";
import { sendProtectedStructured, extractPhoneDeterministic } from "../privacy-gate";
import { recordAudit } from "@/modules/audit/service";
import { matchProductByAnyName } from "@/modules/products/name-match";
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

const KNOWLEDGE_LIMIT = 4;

/**
 * Extraction only classifies, and the reply can go on without it (heuristic
 * fallback below), so it must never spend the job's 120s limit. The response
 * call keeps AI_REQUEST_TIMEOUT_MS.
 */
function extractionTimeoutMs(): number {
  return Math.max(1000, parseInt(process.env.AI_EXTRACTION_TIMEOUT_MS ?? "15000", 10) || 15000);
}

function extractionAttempts(): number {
  return Math.min(3, Math.max(1, parseInt(process.env.AI_EXTRACTION_ATTEMPTS ?? "1", 10) || 1));
}

/** Started now, awaited later: a failure must surface there, not as unhandled. */
function startedEarly<T>(work: Promise<T>): Promise<T> {
  work.catch(() => undefined);
  return work;
}

// Pure visual asks are safe to classify without the model — they carry no
// order fields. Any order/price/contact signal keeps the normal path so a
// message like «ورجيني الصورة وكم سعرها» still gets full extraction.
const MEDIA_FAST_PATH_BLOCKERS =
  /طلب|طلبي|طلبية|أطلب|اطلب|سعر|بكم|كم\s|توصيل|شحن|عنوان|هاتف|رقم|دفع|تحويل|موظف|شكوى|إلغاء|الغاء|تعديل|إرجاع|ارجاع|اسمي/i;

// Pure small-talk only. A whitelist (not "anything unknown") keeps dialect
// buying verbs («أبغى»، «بدي»، «ناوي») on the normal extraction path — a short
// message can still be an order.
const SMALL_TALK =
  /^(?:شكرا|شكرًا|مشكور|مشكورة|يسلمو|تسلم|تسلمي|تمام|أوكي|اوكي|أوك|ok|okay|حلو|ممتاز|رائع|كيفك|كيف حالك|شو أخبارك|شو الاخبار|صباح الخير|مساء الخير|مع السلامة|باي|thanks|thank you)[\s!.,،؟?❤️🌹🙏]*$/iu;


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

  // Read-only and independent of what the model extracts: running while the
  // catalog and the extraction call do. Awaited where they are used.
  const memoriesPending = startedEarly(loadMemory(db, params.workspaceId, customer.id));

  // Catalog resolution runs FIRST: the page's catalog scopes the history the
  // model sees, the REPLY candidates and — through the same allowlist — ORDER
  // INTAKE below. One resolution, one trusted source; no second round-trip.
  // resolveCatalogForChannel short-circuits workspaces with no catalogs
  // internally:
  // no_catalogs → undefined (legacy: every product may answer/order),
  // assigned+active → ids, otherwise → [] (nothing may answer/order).
  const { resolveCatalogForChannel, catalogProductIds } = await import(
    "@/modules/catalog/service"
  );
  const resolved = await resolveCatalogForChannel(db, params.workspaceId, conversation.channelId);
  log.info(
    { conversationId: conversation.id, channelId: conversation.channelId, catalog: resolved.status },
    "ai_catalog_resolved"
  );
  const allowedProductIds =
    resolved.status === "ok"
      ? await catalogProductIds(db, params.workspaceId, resolved.catalog.id, resolved.catalog)
      : resolved.status === "no_catalogs"
        ? undefined
        : [];

  // Document search needs only the words and the page's catalog, not the
  // extracted product: it runs during the extraction call below.
  const vectorStore = deps.vectorStore ?? getVectorStore();
  // Documents enrich the reply; they never decide whether it goes out. A
  // failed or slow embedding call used to throw out of the whole pipeline,
  // and the job waited its 30s back-off with the customer unanswered.
  const chunksPending = startedEarly(
    searchKnowledgeChunks(db, vectorStore, {
      workspaceId: params.workspaceId,
      query: customerText,
      limit: KNOWLEDGE_LIMIT,
      allowedProductIds,
    }).catch((err) => {
      log.warn(
        { conversationId: conversation.id, messageId: message.id, error: err instanceof Error ? err.message : "knowledge_search_failed" },
        "knowledge_search_failed"
      );
      return [];
    })
  );

  // P18 — حدود الكتالوج: أسماء المنتجات المسموحة تُحقن بتعليمات الرد، وأسماء
  // المنتجات خارجها تُشال من الذاكرة/الملخص/السجل كي لا «يتذكّرها» الذكاء.
  // undefined = ما في كتالوجات أصلًا (سلوك قديم) → بلا حدود ولا فلترة.
  const recallGuard = await loadRecallGuard(db, params.workspaceId, allowedProductIds);
  const catalogBoundary = recallGuard ? buildCatalogBoundary(recallGuard.allowedNames) : undefined;

  // 5. Intent + entity extraction (structured, repaired, retried, fallback).
  const modelCfg = resolveModel(settings, "EXTRACTION");
  // Newest-last copy; the original array is shared with later stages.
  const historyAsc = [...recentMessages].reverse();
  const extractionUser = wrapUntrustedCustomerContent(
    customerText,
    scrubRecalledHistory(recallGuard, historyAsc, message.id).map((m) => ({
      sender: m.senderType,
      // `||`: a media-only reply is stored with empty text.
      text: m.text || "[وسائط]",
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
  // Speed: a short, pure «ورجيني الصورة» / "send me a photo" carries no order
  // data, so it skips a whole blocking extraction round-trip. The product is
  // still resolved from the current text or the recent history (below).
  const mediaFastPath =
    wantsMedia(customerText) !== null &&
    customerText.trim().length <= 80 &&
    !/\d/.test(customerText) &&
    !MEDIA_FAST_PATH_BLOCKERS.test(customerText) &&
    !looksLikeInjection(customerText);
  // Speed: pure small-talk ("شكراً"، "تمام"، "كيفك") has no entities to
  // extract. Skipping the extraction call removes one full blocking model
  // round-trip. The whitelist is deliberate: any other short message keeps the
  // normal path so orders/prices/addresses (in any dialect) are never guessed.
  const generalFastPath =
    heuristicPre.intent === "UNKNOWN" &&
    customerText.trim().length > 0 &&
    customerText.trim().length <= 40 &&
    SMALL_TALK.test(customerText.trim()) &&
    !/\d/.test(customerText) &&
    !looksLikeInjection(customerText);
  try {
    if (fastPathGreeting || mediaFastPath || generalFastPath) {
      extraction = {
        intent: mediaFastPath ? "PRODUCT_QUESTION" : heuristicPre.intent,
        confidence: heuristicPre.confidence,
        entities: {},
        missingFields: [],
        memories: [],
        requestedAction: "ANSWER",
      };
      fx.stageMs.extractionSkipped = 1;
    } else {
      // P14 — توضيح: هذه المرحلة (`extraction` في توقيتات خط الأنابيب) هي
      // استخراج **نية/كيانات الرسالة** (منتج/كمية/عنوان…) اللازمة لصياغة الرد،
      // داخل مسار الرد المتزامن. أما `extract_customer_intel` فهي **مهمة خلفية
      // مستقلة** تستخرج **ملف العميل** (اسم/رقم/مدينة…) بعد الإرسال ولا يتسلسل
      // الرد وراءها إطلاقًا. الاثنان مختلفان — لا يخلط بينهما.
      const res = await timed("extraction", () =>
        withRetry(
          () =>
            sendProtectedStructured(provider, {
              system: extractionSystem,
              user: extractionUser,
              model: modelCfg.model,
              temperature: modelCfg.temperature,
              maxTokens: modelCfg.maxTokens,
              timeoutMs: extractionTimeoutMs(),
              validate: (raw) => validateStructured(extractionResultSchema, raw),
            }, { pii: customerPII, trustedContacts, purpose: "EXTRACTION" }),
          { attempts: extractionAttempts() }
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
        allowedProductIds,
      });
    } catch (err) {
      log.error({ err }, "order_intelligence_failed");
    }
  }

  // 6+7. Memory + product resolution are independent — run concurrently.
  // buildAIContext still waits for productId (dependency), but memory no
  // longer blocks product lookup and vice versa.
  // Newest-first history without the current message: lets «ورجيني الصورة»
  // resolve the product discussed moments ago. The customer's own words are
  // tried before the AI's (an AI reply may name alternatives).
  const historyNewestFirst = [...historyAsc].reverse().filter((m) => m.id !== message.id);
  const historyForProduct = [
    ...historyNewestFirst.filter((m) => m.senderType === "CUSTOMER"),
    ...historyNewestFirst.filter((m) => m.senderType !== "CUSTOMER"),
  ];
  const [memories, productId] = await timed("memoryProduct", () =>
    Promise.all([
      memoriesPending,
      resolveProductId(
        db,
        params.workspaceId,
        extraction,
        customerText,
        allowedProductIds,
        historyForProduct
      ),
    ])
  );
  const context = await timed("context", () =>
    buildAIContext(db, vectorStore, {
      workspaceId: params.workspaceId,
      query: customerText,
      productId: productId ?? undefined,
      // P18 — نفس حدود الصفحة تُطبَّق على المعرفة/الأسئلة الجاهزة.
      allowedProductIds,
      knowledgeLimit: KNOWLEDGE_LIMIT,
      preloadedChunks: chunksPending,
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
          allowedProductIds,
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
      catalogBoundary,
      recallGuard,
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
  allowedIds?: string[] | null,
  // Newest-first history. Only consulted when the current message names no
  // product and either asks for a picture («ورجيني الصورة») or follows up
  // on the product just discussed («قديش سعره» · «تمام بدي اطلب»).
  history: { senderType: string; text: string | null }[] = []
): Promise<string | null> {
  const candidates: string[] = [];
  if (extraction.entities.product) candidates.push(extraction.entities.product);
  // Context-based fallback: match product names against words in the message
  // ("بدي 3" after a product mention resolves via this path).
  candidates.push(...productSearchWords(customerText));
  const direct = await findProductId(db, workspaceId, candidates, allowedIds);
  if (direct) return direct;
  if (wantsMedia(customerText) === null && !refersToDiscussedProduct(extraction)) return null;
  for (const past of history) {
    if (!past.text || past.text === customerText) continue;
    const found = await findProductId(
      db,
      workspaceId,
      productSearchWords(past.text),
      allowedIds
    );
    if (found) return found;
  }
  return null;
}

/**
 * Follow-ups about "it" — price, stock, usage, ordering — mean the product
 * discussed moments ago. Without it the reply had no trusted price, the model
 * quoted the price from its own earlier reply, the price guard rejected that
 * as UNSUPPORTED_PRICE twice, and the customer got no reply at all.
 * Greetings, delivery, complaints and unknown text keep no product.
 */
const PRODUCT_FOLLOW_UP_INTENTS = new Set([
  "PRODUCT_QUESTION",
  "PRICE_QUESTION",
  "AVAILABILITY",
  "HOW_TO_USE",
  "BENEFITS",
  "ORDER_CREATE",
  "ORDER_UPDATE",
]);

function refersToDiscussedProduct(extraction: ExtractionResult): boolean {
  return PRODUCT_FOLLOW_UP_INTENTS.has(extraction.intent) || extraction.requestedAction === "CREATE_ORDER";
}

/** Single query for all candidates (latency fix: never N sequential reads). */
async function findProductId(
  db: Db,
  workspaceId: string,
  candidates: string[],
  allowedIds?: string[] | null
): Promise<string | null> {
  if (!candidates.length) return null;
  if (allowedIds && allowedIds.length === 0) return null;
  const ors: { name: { contains: string; mode: "insensitive" } }[] = [];
  for (const name of candidates.slice(0, 12)) {
    ors.push({ name: { contains: name, mode: "insensitive" } });
    const cleaned = name.replace(/^(ال|الـ)/, "");
    if (cleaned !== name) ors.push({ name: { contains: cleaned, mode: "insensitive" } });
  }
  const products = await db.product.findMany({
    where: {
      workspaceId,
      isActive: true,
      isArchived: false,
      ...(allowedIds ? { id: { in: allowedIds } } : {}),
      OR: ors,
    },
    select: { id: true, name: true },
    take: 50,
  });
  const direct = pickBestProductMatch(candidates.slice(0, 12), products);
  if (direct) return direct;

  // ⚠️ البحث فوق حرفي: «ماء الكماة» ما بتطابق «ماء الكمأ»، فالرد بيطلع بلا
  // سعر مع إن السعر مسجّل. 🔧 محاولة تانية بعد التطبيع العربي (الهمزات ·
  // التاء المربوطة · الألف المقصورة · التشكيل) على منتجات الصفحة بس.
  const scope = (await db.product.findMany({
    where: {
      workspaceId,
      isActive: true,
      isArchived: false,
      ...(allowedIds ? { id: { in: allowedIds } } : {}),
    },
    select: { id: true, name: true, aliases: true },
    take: 500,
  })) as Array<{ id: string; name: string; aliases?: string[] | null }>;
  // الاسم التاني (من الـ OMS) بيتعامل معاملة الاسم الأصلي بالبحث.
  const searchable = scope.flatMap((p) => [
    { id: p.id, name: p.name },
    ...(p.aliases ?? []).filter((a) => a && a.trim().length > 0).map((a) => ({ id: p.id, name: a })),
  ]);
  return matchProductByAnyName(candidates.slice(0, 12), searchable)?.id ?? null;
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
