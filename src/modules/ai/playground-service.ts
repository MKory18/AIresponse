import { AppError, NotFoundError } from "@/core/errors";
import type { ActorContext, Db } from "@/modules/customers/service";
import { getAIProvider } from "./provider";
import { getWorkspaceProvider, loadAISettings, resolveModel } from "./router";
import { resolveChannelPersona, type ResolvedPersona } from "./channel-persona";
import {
  buildKnowledgeContext,
  buildProductContext,
  type Citation,
} from "./context-builder";
import {
  coreSystemRules,
  personaPrompt,
  trustedDataPrompt,
  wrapUntrustedCustomerContent,
  responseInstruction,
  extractionInstruction,
  PROMPT_VERSIONS,
} from "./prompts";
import { validateResponse } from "./guardrails";
import { extractionResultSchema, validateStructured } from "./structured";
import type { VectorStore } from "@/modules/knowledge/vector-store";

/**
 * Internal AI Playground — fully isolated from production.
 *
 * HARD GUARANTEES (enforced by construction, not convention):
 * - Never calls processIncomingMessage / dispatchOutbound / the Facebook sender.
 * - Never creates Customer, ChannelIdentity, Conversation, Message, Order,
 *   OrderDraft, HumanHandoff, CustomerMemory, or AIUsageLog rows.
 * - Never runs handleOrderIntent (order writes). The optional order proposal
 *   is a pure LLM extraction validated by Zod — dry-run display only.
 * - All persistence goes to PlaygroundSession/PlaygroundMessage only.
 * - Mock provider is refused in production (getAIProvider already
 *   fail-closes; double-checked here explicitly).
 */

export interface PlaygroundSource {
  kind: "document" | "faq" | "product" | "media";
  id: string;
  title: string;
  score?: number;
  preview?: string;
}

export interface PlaygroundDebug {
  provider: string;
  model: string;
  task: string;
  persona: { name: string; source: ResolvedPersona["source"]; version: number | null };
  page: { id: string; name: string } | null;
  knowledgeUsed: boolean;
  productUsed: boolean;
  draftUsed: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  violations: string[];
}

export interface PlaygroundReply {
  messageId: string;
  response: string;
  sources: PlaygroundSource[];
  debug: PlaygroundDebug;
  orderProposal?: {
    intent: string;
    confidence: number;
    entities: Record<string, unknown>;
    missingFields: string[];
    requestedAction: string;
  } | null;
}

type Store = {
  playgroundSession: {
    create: (a: unknown) => Promise<never>;
    findMany: (a: unknown) => Promise<never[]>;
    findUnique: (a: unknown) => Promise<never | null>;
    update: (a: unknown) => Promise<never>;
    delete: (a: unknown) => Promise<never>;
  };
  playgroundMessage: {
    create: (a: unknown) => Promise<never>;
    findMany: (a: unknown) => Promise<never[]>;
    deleteMany: (a: unknown) => Promise<{ count: number }>;
  };
  channel: { findUnique: (a: unknown) => Promise<{ id: string; displayName?: string | null } | null> };
  persona: { findFirst: (a: unknown) => Promise<{ id: string } | null> };
  product: { findUnique: (a: unknown) => Promise<{ id: string; workspaceId: string } | null> };
};

function storeOf(db: Db): Store {
  return db as unknown as Store;
}

async function assertWorkspaceOwned(
  db: Db,
  workspaceId: string,
  model: "persona" | "channel" | "product",
  id: string,
  label: string
): Promise<void> {
  const s = storeOf(db);
  if (model === "persona") {
    const row = await s.persona.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundError(label);
    return;
  }
  if (model === "channel") {
    const row = await s.channel.findUnique({ where: { id } });
    if (!row) throw new NotFoundError(label);
    return;
  }
  const row = await s.product.findUnique({ where: { id } });
  if (!row || (row as { workspaceId?: string }).workspaceId !== workspaceId) {
    throw new NotFoundError(label);
  }
}

async function getOwnedSession(db: Db, workspaceId: string, sessionId: string) {
  const session = (await storeOf(db).playgroundSession.findUnique({
    where: { id: sessionId },
  })) as unknown as Record<string, unknown> | null;
  if (!session || session.workspaceId !== workspaceId) throw new NotFoundError("Playground session");
  return session as unknown as {
    id: string;
    workspaceId: string;
    personaId: string | null;
    channelId: string | null;
    productId: string | null;
    useKnowledge: boolean;
    model: string | null;
  };
}

export async function createPlaygroundSession(
  db: Db,
  ctx: ActorContext,
  input: { personaId?: string | null; channelId?: string | null; productId?: string | null; useKnowledge?: boolean; model?: string | null }
) {
  if (input.personaId) await assertWorkspaceOwned(db, ctx.workspaceId, "persona", input.personaId, "Persona");
  if (input.channelId) await assertWorkspaceOwned(db, ctx.workspaceId, "channel", input.channelId, "Channel");
  if (input.productId) await assertWorkspaceOwned(db, ctx.workspaceId, "product", input.productId, "Product");
  return (await storeOf(db).playgroundSession.create({
    data: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      personaId: input.personaId ?? null,
      channelId: input.channelId ?? null,
      productId: input.productId ?? null,
      useKnowledge: input.useKnowledge ?? true,
      model: input.model?.slice(0, 120) ?? null,
    },
  })) as unknown;
}

export async function listPlaygroundSessions(db: Db, ctx: ActorContext, limit = 20) {
  return (await storeOf(db).playgroundSession.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ updatedAt: "desc" }],
    take: Math.min(limit, 50),
  })) as unknown;
}

export async function getPlaygroundSession(db: Db, ctx: ActorContext, sessionId: string) {
  const session = await getOwnedSession(db, ctx.workspaceId, sessionId);
  const messages = (await storeOf(db).playgroundMessage.findMany({
    where: { sessionId, workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  })) as unknown;
  return { session, messages };
}

export async function deletePlaygroundSession(db: Db, ctx: ActorContext, sessionId: string) {
  await getOwnedSession(db, ctx.workspaceId, sessionId);
  await storeOf(db).playgroundMessage.deleteMany({ where: { sessionId } });
  await storeOf(db).playgroundSession.delete({ where: { id: sessionId } });
  return { ok: true };
}

const HISTORY_LIMIT = 20;

/** Resolve the exact provider or fail with a safe, user-facing error. */
function requireRealProvider() {
  let provider;
  try {
    provider = getAIProvider();
  } catch (err) {
    throw new AppError("الذكاء الاصطناعي غير مهيأ", 503, "AI_NOT_CONFIGURED");
  }
  if (provider.name === "mock" && process.env.NODE_ENV === "production" && !process.env.ALLOW_MOCK_AI) {
    throw new AppError("الذكاء الاصطناعي غير مهيأ", 503, "AI_NOT_CONFIGURED");
  }
  return provider;
}

export async function sendPlaygroundMessage(
  db: Db,
  ctx: ActorContext,
  sessionId: string,
  text: string,
  opts?: {
    withOrderProposal?: boolean;
    /** Optional display-only test name (prompt context only — never a Customer row). */
    customerName?: string;
    vectorStore?: VectorStore;
    embedder?: { embed: (text: string) => Promise<number[]> };
    /** P6: test unpublished instructions without touching production rows. */
    draftInstructions?: string | null;
    /** P6: test a specific PersonaVersion snapshot (workspace-scoped). */
    personaVersionId?: string | null;
    /** P6: which task model to exercise (default RESPONSE). */
    task?: "RESPONSE" | "EXTRACTION" | "SUMMARY";
  }
): Promise<PlaygroundReply> {
  const started = Date.now();
  const session = await getOwnedSession(db, ctx.workspaceId, sessionId);
  const s = storeOf(db);

  // 1. Persist the user turn (playground tables only).
  await s.playgroundMessage.create({
    data: { sessionId, workspaceId: ctx.workspaceId, role: "user", text, metadata: {} },
  });

  // 2. Same persona logic as production: explicit override → page → workspace → builtin.
  // P6: a version snapshot or draft instructions override IN MEMORY ONLY —
  // the live Persona row is never written from the playground.
  let persona: ResolvedPersona;
  let draftUsed = false;
  if (opts?.personaVersionId) {
    const snap = (await (db as unknown as { personaVersion: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> } }).personaVersion.findUnique({
      where: { id: opts.personaVersionId },
    })) as Record<string, unknown> | null;
    if (!snap || snap.workspaceId !== ctx.workspaceId) throw new NotFoundError("Persona version");
    persona = {
      id: snap.personaId as string,
      name: `${(snap.name as string) ?? "المساعد"} (مسودة v${snap.version as number})`,
      language: (snap.language as string) ?? "ar",
      dialect: (snap.dialect as string | null) ?? null,
      tone: (snap.tone as string) ?? "friendly",
      formality: (snap.formality as string) ?? "informal",
      responseLength: (snap.responseLength as string) ?? "short",
      emojiLevel: (snap.emojiLevel as number) ?? 1,
      salesStyle: (snap.salesStyle as string) ?? "helpful",
      systemInstructions: (snap.systemInstructions as string | null) ?? null,
      prohibitedPhrases: (snap.prohibitedPhrases as string[]) ?? [],
      customRules: (snap.customRules as string[]) ?? [],
      version: (snap.version as number) ?? null,
      source: "workspace",
      channelPage: null,
    };
    draftUsed = true;
  } else if (session.personaId) {
    await assertWorkspaceOwned(db, ctx.workspaceId, "persona", session.personaId, "Persona");
    const row = (await (db as unknown as { persona: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> } }).persona.findFirst({
      where: { id: session.personaId, workspaceId: ctx.workspaceId },
    })) as Record<string, unknown>;
    persona = {
      id: session.personaId,
      name: (row?.name as string) ?? "المساعد",
      language: (row?.language as string) ?? "ar",
      dialect: (row?.dialect as string | null) ?? null,
      tone: (row?.tone as string) ?? "friendly",
      formality: (row?.formality as string) ?? "informal",
      responseLength: (row?.responseLength as string) ?? "short",
      emojiLevel: (row?.emojiLevel as number) ?? 1,
      salesStyle: (row?.salesStyle as string) ?? "helpful",
      systemInstructions: (row?.systemInstructions as string | null) ?? null,
      prohibitedPhrases: (row?.prohibitedPhrases as string[]) ?? [],
      customRules: (row?.customRules as string[]) ?? [],
      version: typeof row?.version === "number" ? (row.version as number) : null,
      source: "workspace",
      channelPage: null,
    };
  } else {
    persona = await resolveChannelPersona(db, { workspaceId: ctx.workspaceId, channelId: session.channelId });
  }
  // P6: draft instructions override in memory only (length-capped, never saved).
  if (opts?.draftInstructions !== undefined && opts.draftInstructions !== null) {
    const draft = opts.draftInstructions.slice(0, 20_000);
    persona = { ...persona, systemInstructions: draft.length ? draft : persona.systemInstructions };
    draftUsed = true;
  }

  // 3. Trusted context: selected product + knowledge (when enabled). Workspace-scoped.
  const [productCtx, knowledgeCtx] = await Promise.all([
    session.productId
      ? buildProductContext(db, ctx.workspaceId, session.productId)
      : Promise.resolve({ product: undefined, citations: [] as Citation[] }),
    session.useKnowledge
      ? buildKnowledgeContext(db, opts?.vectorStore ?? (await defaultVectorStore(db)), {
          workspaceId: ctx.workspaceId,
          query: text,
          productId: session.productId ?? undefined,
          limit: 4,
        })
      : Promise.resolve({
          knowledge: { faqs: [], documents: [] },
          citations: [] as Citation[],
        }),
  ]);

  // 4. Multi-turn history (playground-only memory).
  const history = (await s.playgroundMessage.findMany({
    where: { sessionId, workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 500,
  })) as unknown as Array<{ role: string; text: string }>;
  const transcript = history.slice(-HISTORY_LIMIT, -1).map((m) => ({
    sender: m.role === "user" ? "CUSTOMER" : "AI",
    text: m.text,
  }));

  // 5. Real provider (fail-closed) + model routing (AISettings → ENV → defaults).
  // P6: workspace-aware resolution (settings provider choice is effective) +
  // per-call task selection (EXTRACTION/SUMMARY exercise their own models).
  const settings = await loadAISettings(db, ctx.workspaceId).catch(() => null);
  let provider: ReturnType<typeof requireRealProvider>;
  try {
    provider = getWorkspaceProvider((settings ?? null) as never);
    void provider.name;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/AI_NOT_CONFIGURED/.test(msg)) throw new AppError("الذكاء الاصطناعي غير مهيأ", 503, "AI_NOT_CONFIGURED");
    throw err;
  }
  const task = opts?.task ?? "RESPONSE";
  const modelCfg = resolveModel(settings as never, task);
  const model = session.model ?? modelCfg.model;

  const system = [
    coreSystemRules(),
    personaPrompt(persona),
    trustedDataPrompt({
      product: productCtx.product
        ? {
            name: productCtx.product.name,
            price: `${productCtx.product.price} ${productCtx.product.currency ?? ""}`.trim(),
            currency: productCtx.product.currency ?? "",
            stockStatus: productCtx.product.stockStatus,
            shortDescription: productCtx.product.shortDescription,
            benefits: productCtx.product.benefits,
            usage: productCtx.product.usage,
            warnings: productCtx.product.warnings,
            objections: productCtx.product.objections,
            salesNotes: productCtx.product.salesNotes,
            // P12 — قواعد سيستم 1 متل الإنتاج.
            compliance: productCtx.product.compliance ?? null,
            faqs: productCtx.product.faqs,
          }
        : undefined,
      knowledge: { faqs: knowledgeCtx.knowledge.faqs, documents: knowledgeCtx.knowledge.documents },
      customer: opts?.customerName?.trim()
        ? { name: opts.customerName.trim().slice(0, 100), page: null }
        : undefined,
    }),
  ].join("\n\n");
  const userPrompt = [
    wrapUntrustedCustomerContent(text, transcript),
    responseInstruction(persona),
  ].join("\n\n");

  // P1 privacy gate: operator-typed test turns may paste real customer
  // data — external models receive tokens only (restored locally for the
  // operator's own display). Mock/local providers bypass by design.
  const { sendProtectedText, sendProtectedStructured } = await import("./privacy-gate");
  const playgroundPII = opts?.customerName?.trim() ? { name: opts.customerName.trim().slice(0, 100) } : {};
  // P1.1: quoted product figures must survive reply-side scrubbing.
  const playgroundAllowedNumbers: Array<string | number> =
    productCtx.product && (productCtx.product as { price?: string | number }).price !== undefined
      ? [(productCtx.product as { price?: string | number }).price as string | number]
      : [];

  let res;
  try {
    res = await sendProtectedText(provider, { system, user: userPrompt, model, temperature: modelCfg.temperature, maxTokens: modelCfg.maxTokens }, { pii: playgroundPII, allowedNumbers: playgroundAllowedNumbers, purpose: "PLAYGROUND" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/AI_NOT_CONFIGURED/.test(msg)) throw new AppError("الذكاء الاصطناعي غير مهيأ", 503, "AI_NOT_CONFIGURED");
    throw new AppError("تعذر تشغيل الذكاء الاصطناعي", 502, "AI_FAILED");
  }
  let responseText = (res.text ?? "").trim();
  const guard = validateResponse({
    response: responseText,
    context: productCtx.product ? ({ product: productCtx.product } as never) : null,
    prohibitedPhrases: persona.prohibitedPhrases,
  });
  if (!guard.valid) {
    // NO static customer-facing fallback — the application never invents a
    // reply. Regenerate once; if guardrails still reject, surface the failure
    // instead of fabricating text.
    const retry = await sendProtectedText(provider, { system, user: userPrompt, model, temperature: 0.2, maxTokens: modelCfg.maxTokens }, { pii: playgroundPII, allowedNumbers: playgroundAllowedNumbers, purpose: "PLAYGROUND_RETRY" });
    const retryText = (retry.text ?? "").trim();
    const retryGuard = validateResponse({
      response: retryText,
      context: productCtx.product ? ({ product: productCtx.product } as never) : null,
      prohibitedPhrases: persona.prohibitedPhrases,
    });
    if (!retryGuard.valid || !retryText) {
      throw new AppError("تعذر توليد رد ملتزم بالقواعد — أعد المحاولة", 502, "GUARDRAIL_REJECTED");
    }
    responseText = retryText;
  }

  // 6. Optional dry-run order proposal: pure LLM extraction, zero DB writes.
  let orderProposal: PlaygroundReply["orderProposal"] = null;
  if (opts?.withOrderProposal) {
    try {
      const raw = await sendProtectedStructured(provider, {
        system: `${coreSystemRules()}\n\n${extractionInstruction()}`,
        user: wrapUntrustedCustomerContent(text, transcript),
        model,
        temperature: 0.2,
        maxTokens: 400,
        validate: (v) => validateStructured(extractionResultSchema, v),
      }, { pii: playgroundPII, purpose: "PLAYGROUND_PROPOSAL" });
      const v = raw.value as { intent: string; confidence: number; entities: Record<string, unknown>; missingFields: string[]; requestedAction: string };
      orderProposal = {
        intent: v.intent,
        confidence: v.confidence,
        entities: v.entities ?? {},
        missingFields: v.missingFields ?? [],
        requestedAction: v.requestedAction,
      };
    } catch {
      orderProposal = null;
    }
  }

  // 7. Sources for the "المصادر المستخدمة" panel (titles resolved workspace-scoped).
  const sources: PlaygroundSource[] = [];
  if (productCtx.product) {
    sources.push({ kind: "product", id: productCtx.product.id, title: productCtx.product.name });
  }
  for (const f of knowledgeCtx.knowledge.faqs) {
    sources.push({ kind: "faq", id: f.id, title: f.question });
  }
  for (const d of knowledgeCtx.knowledge.documents) {
    sources.push({
      kind: "document",
      id: d.id,
      title: d.id,
      score: d.score,
      preview: d.content.slice(0, 200),
    });
  }
  if (sources.length > 0) {
    // Resolve real document titles for chunk sources (workspace-scoped).
    const chunkIds = knowledgeCtx.knowledge.documents.map((d) => d.id);
    const chunks = chunkIds.length
      ? await (db as unknown as { knowledgeChunk: { findMany: (a: unknown) => Promise<Array<{ id: string; documentId: string }>> } }).knowledgeChunk.findMany({
          where: { id: { in: chunkIds }, workspaceId: ctx.workspaceId },
          select: { id: true, documentId: true },
        }).catch(() => [])
      : [];
    const docIds = [...new Set(chunks.map((c) => c.documentId))];
    const docs = docIds.length
      ? await (db as unknown as { knowledgeDocument: { findMany: (a: unknown) => Promise<Array<{ id: string; title: string }>> } }).knowledgeDocument.findMany({
          where: { id: { in: docIds }, workspaceId: ctx.workspaceId },
          select: { id: true, title: true },
        }).catch(() => [])
      : [];
    const docById = new Map(docs.map((d) => [d.id, d.title]));
    const chunkDocById = new Map(chunks.map((c) => [c.id, c.documentId]));
    for (const src of sources) {
      if (src.kind !== "document") continue;
      const docId = chunkDocById.get(src.id);
      if (docId && docById.has(docId)) src.title = docById.get(docId) as string;
    }
  }

  // 8. Page info for the debug panel (read-only, workspace-scoped).
  let page: PlaygroundDebug["page"] = null;
  if (session.channelId) {
    const ch = (await s.channel
      .findUnique({ where: { id: session.channelId } })
      .catch(() => null)) as unknown as { id: string; workspaceId?: string; displayName?: string | null } | null;
    if (ch && (!ch.workspaceId || ch.workspaceId === ctx.workspaceId)) {
      page = { id: ch.id, name: ch.displayName ?? ch.id };
    }
  }

  const debug: PlaygroundDebug = {
    provider: provider.name,
    model,
    task,
    persona: { name: persona.name, source: persona.source, version: persona.version ?? null },
    page,
    knowledgeUsed: session.useKnowledge,
    productUsed: Boolean(session.productId),
    draftUsed,
    latencyMs: Date.now() - started,
    promptTokens: res.promptTokens ?? 0,
    completionTokens: res.completionTokens ?? 0,
    violations: guard.violations,
  };

  const assistant = (await s.playgroundMessage.create({
    data: {
      sessionId,
      workspaceId: ctx.workspaceId,
      role: "assistant",
      text: responseText,
      metadata: {
        provider: debug.provider,
        model: debug.model,
        task: debug.task,
        persona: debug.persona,
        personaVersion: persona.version ?? null,
        draftUsed,
        promptVersion: PROMPT_VERSIONS.RESPONSE,
        latencyMs: debug.latencyMs,
        promptTokens: debug.promptTokens,
        completionTokens: debug.completionTokens,
        sources,
        violations: debug.violations,
        orderProposal,
      },
    },
  })) as unknown as { id: string };

  await (storeOf(db).playgroundSession as unknown as { update: (a: unknown) => Promise<unknown> }).update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  }).catch(() => {});

  return { messageId: assistant.id, response: responseText, sources, debug, orderProposal };
}

type RawSqlDb = {
  $queryRawUnsafe: (sql: string, ...params: Array<unknown>) => Promise<Array<Record<string, unknown>>>;
};

async function defaultVectorStore(db: Db): Promise<VectorStore> {
  const { PgVectorStore } = await import("@/modules/knowledge/vector-store");
  const raw = db as unknown as RawSqlDb;
  return new PgVectorStore((sql, params) => raw.$queryRawUnsafe(sql, ...params));
}
