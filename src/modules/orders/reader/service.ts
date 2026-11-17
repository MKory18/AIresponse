import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/jobs/service";
import type { AIProvider } from "@/modules/ai/provider";
import { saveNoneReading, saveShadowReading, markReadingFailed } from "./apply";
import { shouldReadConversation } from "./filter";
import { getOrderMode } from "./schedule";
import { publishRealtime } from "@/modules/realtime/events";
import { readConversation } from "./read";
import type { CatalogProduct } from "./verify";
import { normalizeOrderFields, DEFAULT_ORDER_FIELDS, type OrderFieldKey } from "@/modules/orders/required-fields";

const log = childLogger("order-reader");

/** لو مهمة الرد على آخر رسالة لسا شغّالة: أجّل القراءة لتدخل ردّ الوكيل بالنص. */
export const DEFER_FOR_PENDING_REPLY_MS = 20_000;
/** أقصى عمر لانتظار مهمة الرد قبل ما نقرأ بدونها. */
export const MAX_REPLY_WAIT_MS = 120_000;
/** عدد الرسائل اللي بتنقرأ للمحادثة. */
export const READER_HISTORY_MESSAGES = 60;

export interface ReadJobDeps {
  provider?: AIProvider;
  now?: () => Date;
}

export interface ReadJobResult {
  success: boolean;
  error?: string;
  deferMs?: number;
  /** نتيجة تطبيق القراءة (READER فقط). */
  applied?: import("./lifecycle").ApplyOutcome | null;
  /** سبب النتيجة (للاختبارات والسجل). */
  outcome?:
    | "LEGACY_DRAFT"
    | "STALE_JOB"
    | "DEFERRED_FOR_REPLY"
    | "ALREADY_READ"
    | "FILTERED_NONE"
    | "READ"
    | "NOT_FOUND"
    | "FAILED";
}

type Row = Record<string, unknown>;

/**
 * معالج مهمة `read_conversation` (§8.2) — بوضع الظل بيحفظ القراءة وبس.
 * `READER_SHADOW` و`READER` (لحد 1.4) نفس السلوك: قراءة محفوظة · ولا طلب · ولا رسالة.
 */
export async function handleReadConversationJob(
  db: Db,
  payload: Record<string, unknown>,
  workspaceId: string,
  deps: ReadJobDeps = {}
): Promise<ReadJobResult> {
  const now = deps.now ?? (() => new Date());
  const conversationId = String(payload.conversationId ?? "");
  const throughMessageId = String(payload.throughMessageId ?? "");
  const trigger = payload.trigger === "STAFF" ? "STAFF" : "CUSTOMER";
  if (!workspaceId || !conversationId || !throughMessageId) {
    return { success: false, error: "MISSING_READ_PAYLOAD", outcome: "FAILED" };
  }

  const mode = await getOrderMode(db, workspaceId);
  if (mode === "LEGACY_DRAFT") return { success: true, outcome: "LEGACY_DRAFT" };

  const d = db as unknown as Record<string, { findFirst: (a: unknown) => Promise<Row | null>; findMany: (a: unknown) => Promise<Row[]>; findUnique: (a: unknown) => Promise<Row | null> }>;

  const conversation = await d.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true, channelId: true, customerId: true },
  });
  if (!conversation) return { success: true, outcome: "NOT_FOUND" };

  // 1) debounce: مهمة أحدث جاية؟
  const latestOfKind = await d.message.findFirst({
    where: {
      conversationId,
      deletedAt: null,
      isNote: false,
      senderType: trigger === "STAFF" ? "HUMAN" : "CUSTOMER",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!latestOfKind || latestOfKind.id !== throughMessageId) return { success: true, outcome: "STALE_JOB" };

  // آخر رسالة عميل (للتغطية) — ممكن تختلف عن throughMessageId لما السبب رد موظف.
  const lastCustomer = (await d.message.findFirst({
    where: { conversationId, deletedAt: null, isNote: false, senderType: "CUSTOMER" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  })) as { id: string; createdAt: Date } | null;
  if (!lastCustomer) return { success: true, outcome: "FILTERED_NONE" };

  // 2) رد الوكيل على آخر رسالة لسا شغّال؟ أجّل (بحد أقصى).
  const aiJob = (await d.backgroundJob.findFirst({
    where: { type: "process_ai_message", idempotencyKey: `ai:${lastCustomer.id}`, status: { in: ["PENDING", "PROCESSING"] } },
    select: { id: true, createdAt: true },
  })) as { createdAt: Date } | null;
  if (aiJob && now().getTime() - new Date(aiJob.createdAt).getTime() < MAX_REPLY_WAIT_MS) {
    return { success: true, deferMs: DEFER_FOR_PENDING_REPLY_MS, outcome: "DEFERRED_FOR_REPLY" };
  }

  // 3) ما في شي جديد؟
  const prior = (await d.conversationReading.findUnique({ where: { conversationId } })) as {
    readThroughMessageId?: string | null;
    status?: string;
  } | null;
  if (prior && prior.status === "DONE" && prior.readThroughMessageId === lastCustomer.id) {
    return { success: true, outcome: "ALREADY_READ" };
  }

  // 4) النص + الكتالوج + الفلتر
  const rows = (await d.message.findMany({
    where: { conversationId, deletedAt: null, isNote: false },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: READER_HISTORY_MESSAGES,
    select: { id: true, senderType: true, type: true, text: true, createdAt: true, isNote: true, deletedAt: true },
  })) as Array<{ id: string; senderType: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM"; type?: string | null; text?: string | null; createdAt: Date; isNote?: boolean | null; deletedAt?: Date | null }>;
  const messages = [...rows].reverse();

  const channel = conversation.channelId
    ? ((await d.channel.findFirst({
        where: { id: conversation.channelId, workspaceId },
        select: { id: true, name: true, market: true, orderRequiredFields: true },
      })) as { id: string; name?: string | null; market?: string | null; orderRequiredFields?: string[] } | null)
    : null;

  const products = await loadCatalog(db, workspaceId, channel?.id ?? null);
  const hasOpenOrder = !!(await d.order.findFirst({
    where: { workspaceId, conversationId, status: { in: ["NEW", "CONFIRMATION_PENDING", "CONFIRMED"] } },
    select: { id: true },
  }));

  const decision = shouldReadConversation({ messages, productNames: products.map((p) => p.name), hasOpenOrder });
  if (!decision.read) {
    await saveNoneReading(db, {
      workspaceId,
      conversationId,
      readThroughMessageId: lastCustomer.id,
      readThroughAt: new Date(lastCustomer.createdAt),
      now: now(),
    });
    return { success: true, outcome: "FILTERED_NONE" };
  }

  // 5) النداء
  const started = Date.now();
  try {
    const { logUsage } = await import("@/modules/ai/router");
    const { result, provider, model } = await callReader(db, {
      workspaceId,
      customerId: String(conversation.customerId),
      channel,
      messages,
      products,
      deps,
      now: now(),
    });

    const saved = await saveShadowReading(db, {
      workspaceId,
      conversationId,
      mode,
      verified: result.verified,
      readThroughMessageId: lastCustomer.id,
      readThroughAt: new Date(lastCustomer.createdAt),
      now: now(),
    });
    // READER فقط: القراءة بتتحوّل لطلب (إنشاء · تحديث · إلغاء). الظل = القراءة بس.
    let applied: unknown = null;
    if (mode === "READER") {
      const { applyReading } = await import("./lifecycle");
      const { getIntegrationSettings } = await import("@/modules/integrations/settings");
      const settings = await getIntegrationSettings(db, workspaceId);
      applied = await applyReading(db, {
        workspaceId,
        conversationId,
        customerId: String(conversation.customerId),
        verified: result.verified,
        readVersion: saved.version,
        orderSettleMinutes: settings.orderSettleMinutes,
        now: now(),
      });
    }
    void publishReadingUpdated(db, workspaceId, conversationId);
    await logUsage(db, {
      workspaceId,
      conversationId,
      messageId: lastCustomer.id,
      purpose: "ORDER_READ",
      provider: provider.name,
      model,
      promptVersion: result.promptVersion,
      confidence: result.verified.confidence,
      promptTokens: result.usage.promptTokens ?? 0,
      completionTokens: result.usage.completionTokens ?? 0,
      latencyMs: result.usage.latencyMs ?? Date.now() - started,
      success: true,
    });
    log.info({ conversationId, stage: result.verified.stage, version: saved.version, reason: decision.reason, applied }, "reading_saved");
    return { success: true, outcome: "READ", applied: applied as ReadJobResult["applied"] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markReadingFailed(db, { workspaceId, conversationId, error: message }).catch(() => undefined);
    log.warn({ conversationId, error: message.slice(0, 200) }, "reading_failed");
    // الطابور بيعيد المحاولة (30ث/60ث/120ث) وبعدها المهمة بتخلص FAILED.
    return { success: false, error: message, outcome: "FAILED" };
  }
}

export interface CallReaderInput {
  workspaceId: string;
  customerId: string;
  channel: { name?: string | null; market?: string | null; orderRequiredFields?: string[] } | null;
  messages: Parameters<typeof readConversation>[0]["messages"];
  products: CatalogProduct[];
  deps?: ReadJobDeps;
  now: Date;
}

/** نداء القارئ نفسه (بوابة الخصوصية + التحقق) — بلا أي حفظ. بيستعمله المعالج وسكربت الإعادة. */
export async function callReader(db: Db, input: CallReaderInput) {
  const { getWorkspaceProvider, loadAISettings, resolveModel } = await import("@/modules/ai/router");
  const settings = (await loadAISettings(db as never, input.workspaceId)) as never;
  const provider = input.deps?.provider ?? getWorkspaceProvider(settings);
  const model = resolveModel(settings, "EXTRACTION").model;
  const customer = (await (db as unknown as { customer: { findUnique: (a: unknown) => Promise<unknown> } }).customer
    .findUnique({ where: { id: input.customerId }, select: { name: true, phone: true, email: true, address: true, isBlacklisted: true } })
    .catch(() => null)) as { name?: string | null; phone?: string | null; email?: string | null; address?: string | null; isBlacklisted?: boolean | null } | null;
  const required: OrderFieldKey[] = input.channel
    ? normalizeOrderFields(input.channel.orderRequiredFields)
    : [...DEFAULT_ORDER_FIELDS];
  const result = await readConversation({
    provider,
    model,
    messages: input.messages,
    pageName: input.channel?.name ?? "—",
    date: input.now.toISOString().slice(0, 10),
    pii: customer ?? {},
    verify: {
      market: input.channel?.market ?? null,
      products: input.products,
      required,
      customerName: customer?.name ?? null,
      isBlacklisted: customer?.isBlacklisted === true,
    },
  });
  return { result, provider, model };
}

/**
 * إعادة تشغيل القارئ على محادثة حقيقية بلا أي كتابة (سكربت `reader-replay`):
 * بيرجّع القراءة المتحقق منها ونتيجة الفلتر — لمقارنة الظل مع الواقع.
 */
export async function replayConversation(db: Db, workspaceId: string, conversationId: string, deps: ReadJobDeps = {}) {
  const d = db as unknown as Record<string, { findFirst: (a: unknown) => Promise<Row | null>; findMany: (a: unknown) => Promise<Row[]> }>;
  const conversation = (await d.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true, channelId: true, customerId: true },
  })) as { id: string; channelId?: string | null; customerId: string } | null;
  if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
  const rows = (await d.message.findMany({
    where: { conversationId, deletedAt: null, isNote: false },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: READER_HISTORY_MESSAGES,
    select: { id: true, senderType: true, type: true, text: true, createdAt: true, isNote: true, deletedAt: true },
  })) as Array<{ id: string; senderType: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM"; type?: string | null; text?: string | null; createdAt: Date }>;
  const messages = [...rows].reverse();
  const channel = conversation.channelId
    ? ((await d.channel.findFirst({
        where: { id: conversation.channelId, workspaceId },
        select: { id: true, name: true, market: true, orderRequiredFields: true },
      })) as { id: string; name?: string | null; market?: string | null; orderRequiredFields?: string[] } | null)
    : null;
  const products = await loadCatalog(db, workspaceId, channel?.id ?? null);
  const hasOpenOrder = !!(await d.order.findFirst({
    where: { workspaceId, conversationId, status: { in: ["NEW", "CONFIRMATION_PENDING", "CONFIRMED"] } },
    select: { id: true },
  }));
  const decision = shouldReadConversation({ messages, productNames: products.map((p) => p.name), hasOpenOrder });
  if (!decision.read) return { decision, verified: null as null };
  const { result } = await callReader(db, { workspaceId, customerId: conversation.customerId, channel, messages, products, deps, now: new Date() });
  return { decision, verified: result.verified };
}

async function publishReadingUpdated(db: Db, workspaceId: string, conversationId: string) {
  try {
    await publishRealtime(db as never, { workspaceId, type: "reading.updated", conversationId });
  } catch {
    // best-effort
  }
}

/** منتجات الصفحة المسموحة؛ مساحة بلا كتالوجات = كل المنتجات الفعّالة. */
async function loadCatalog(db: Db, workspaceId: string, channelId: string | null): Promise<CatalogProduct[]> {
  const toProduct = (p: Row): CatalogProduct => ({
    id: String(p.id),
    name: String(p.name),
    sku: (p.sku as string | null | undefined) ?? null,
    price: Number(p.price ?? 0),
    currency: String(p.currency ?? "USD"),
  });
  const d = db as unknown as Record<string, { findMany: (a: unknown) => Promise<Row[]> }>;
  if (channelId) {
    const { buildPageProductContext, workspaceHasCatalogs } = await import("@/modules/catalog/service");
    const ctx = await buildPageProductContext(db as never, workspaceId, channelId);
    if (ctx.status === "ok") return (ctx.products as Row[]).map(toProduct);
    if (await workspaceHasCatalogs(db as never, workspaceId)) return []; // صفحة بلا كتالوج = ولا منتج (نفس قاعدة الرد)
  }
  const all = await d.product.findMany({
    where: { workspaceId, isActive: true, isArchived: false },
    select: { id: true, name: true, sku: true, price: true, currency: true },
    take: 300,
  });
  return all.map(toProduct);
}
