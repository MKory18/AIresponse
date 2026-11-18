import { AppError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { isOwnerRole } from "@/modules/rbac/owner-guard";
import type { Db } from "@/modules/jobs/service";
import { integrationSettingsSchema, getIntegrationSettings, type IntegrationSettings } from "@/modules/integrations/settings";
import { summarizeShadow } from "./report";
import type { OrderMode } from "./schedule";

/**
 * القطع لقارئ الطلب (الحزمة 1.9، §14) — **المالك هو اللي بيقرر**؛ هون الأدوات بس:
 *  1. `shadowReadiness`: معيار القطع بالأرقام من بيانات الظل (مش بالإحساس).
 *  2. `changeOrderRules`: تغيير الوضع والإعدادات؛ التحويل لـ `READER` بيطلب تأكيد المراجعة
 *     (وتأكيد المخاطر إذا المعيار ما اكتمل) وبيسكّر المسودات المفتوحة مع تدقيق.
 *  3. الرجوع لـ `LEGACY_DRAFT` بأي لحظة بكبسة: ولا ترحيل ولا حذف.
 */
export const SHADOW_MIN_DAYS = 3;
export const REVIEW_RATE_MAX = 0.25;
export const FAILED_RATE_MAX = 0.1;
export const REVIEW_SAMPLE = 30;

type M = Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
type Row = Record<string, any>;

export interface ReadinessCriterion {
  key: "SHADOW_DAYS" | "NO_MISSED_ORDERS" | "REVIEW_RATE" | "FAILED_RATE" | "MANUAL_SAMPLE";
  label: string;
  /** true/false = محسوب · null = بلا بيانات كافية أو يدوي (المالك بيتحقق). */
  ok: boolean | null;
  detail: string;
}

export interface ShadowReadiness {
  mode: OrderMode;
  readings: number;
  shadowDays: number;
  criteria: ReadinessCriterion[];
  /** كل المعايير المحسوبة نجحت (واليدوي لسا على المالك). */
  computedOk: boolean;
  summary: ReturnType<typeof summarizeShadow>;
  reviewRate: number | null;
}

const DAY = 24 * 3600_000;

export async function shadowReadiness(db: Db, workspaceId: string, now = new Date()): Promise<ShadowReadiness> {
  const d = db as unknown as M;
  const mode = (await getIntegrationSettings(db, workspaceId)).orderMode as OrderMode;
  const readings = (await d.conversationReading.findMany({
    where: { workspaceId },
    select: { conversationId: true, stage: true, status: true, flags: true, missing: true, createdAt: true },
    take: 5000,
  })) as Row[];
  // طلبات المسودة القديمة (draftId != null) = المرجع اللي منقارن معه.
  const legacy = (await d.order.findMany({
    where: { workspaceId, draftId: { not: null }, conversationId: { not: null }, status: { not: "CANCELLED" } },
    select: { conversationId: true },
    take: 5000,
  })) as Row[];

  const summary = summarizeShadow(
    readings.map((r) => ({ conversationId: r.conversationId, stage: r.stage, status: r.status, flags: r.flags ?? [], missing: r.missing ?? [] })),
    legacy.map((o) => o.conversationId as string)
  );
  const first = readings.reduce<number | null>((min, r) => {
    const t = new Date(r.createdAt).getTime();
    return Number.isFinite(t) && (min === null || t < min) ? t : min;
  }, null);
  const shadowDays = first === null ? 0 : Math.floor((now.getTime() - first) / DAY);

  const complete = readings.filter((r) => r.stage === "COMPLETE");
  const flagged = complete.filter((r) => (r.flags ?? []).length > 0).length;
  const reviewRate = complete.length > 0 ? flagged / complete.length : null;
  const failedRate = readings.length > 0 ? summary.failed / readings.length : null;
  const legacyTotal = summary.agreed + summary.legacyOnly;

  const criteria: ReadinessCriterion[] = [
    {
      key: "SHADOW_DAYS",
      label: `الظل شغّال ${SHADOW_MIN_DAYS} أيام على الأقل`,
      ok: first === null ? null : shadowDays >= SHADOW_MIN_DAYS,
      detail: first === null ? "لسا ما في قراءات — فعّل «الظل» أول." : `${shadowDays} يوم · ${readings.length} قراءة`,
    },
    {
      key: "NO_MISSED_ORDERS",
      label: "القارئ لقط كل طلب سجّلته المسودة",
      ok: legacyTotal === 0 ? null : summary.legacyOnly === 0,
      detail:
        legacyTotal === 0
          ? "ما في طلبات مسودة للمقارنة بعد."
          : `${summary.agreed} من ${legacyTotal} متفق${summary.legacyOnly > 0 ? ` · ⚠️ ${summary.legacyOnly} طلب فوّته القارئ` : ""}${summary.readerOnly > 0 ? ` · ${summary.readerOnly} لقطها القارئ لحاله` : ""}`,
    },
    {
      key: "REVIEW_RATE",
      label: `«تحتاج مراجعة» أقل من ${Math.round(REVIEW_RATE_MAX * 100)}%`,
      ok: reviewRate === null ? null : reviewRate < REVIEW_RATE_MAX,
      detail: reviewRate === null ? "ما في قراءات مكتملة بعد." : `${Math.round(reviewRate * 100)}% (${flagged} من ${complete.length})`,
    },
    {
      key: "FAILED_RATE",
      label: `قراءات فاشلة أقل من ${Math.round(FAILED_RATE_MAX * 100)}%`,
      ok: failedRate === null ? null : failedRate < FAILED_RATE_MAX,
      detail: failedRate === null ? "—" : `${summary.failed} فاشلة من ${readings.length}`,
    },
    {
      key: "MANUAL_SAMPLE",
      label: `راجعت عيّنة ${REVIEW_SAMPLE} محادثة بنفسك: ولا طلب غلط`,
      ok: null,
      detail: "ما بينحسب بالنظام — شغّل scripts/reader-replay.ts على المحادثات وراجعها، وأكّد بالتفعيل.",
    },
  ];
  const computed = criteria.filter((c) => c.key !== "MANUAL_SAMPLE");
  return {
    mode,
    readings: readings.length,
    shadowDays,
    criteria,
    computedOk: computed.every((c) => c.ok === true),
    summary,
    reviewRate,
  };
}

/** يسكّر المسودات المفتوحة (CANCELLED) مع سطر تدقيق `order_draft.retired` لكل وحدة. */
export async function retireOpenDrafts(db: Db, workspaceId: string, actorUserId: string | null): Promise<number> {
  const d = db as unknown as M;
  const open = (await d.orderDraft.findMany({
    where: { workspaceId, state: { in: ["EMPTY", "COLLECTING", "READY", "CONFIRMING"] }, orderId: null },
    select: { id: true, state: true },
    take: 2000,
  })) as Row[];
  for (const draft of open) {
    await d.orderDraft.update({ where: { id: draft.id }, data: { state: "CANCELLED" } });
    await recordAudit(db as never, {
      workspaceId,
      userId: actorUserId,
      action: "order_draft.retired",
      entityType: "OrderDraft",
      entityId: draft.id,
      metadata: { from: draft.state, reason: "READER_CUTOVER" },
    });
  }
  return open.length;
}

export type OrderRulesPatch = Partial<Pick<IntegrationSettings, "orderMode" | "orderSettleMinutes" | "orderAutoSeal" | "orderAgreementPolicy" | "orderConfirmMessage">> & {
  /** «راجعت عيّنة المحادثات» — مطلوب للتحويل لـ READER. */
  confirmReviewed?: boolean;
  /** «فهمت إن المعيار ما اكتمل» — مطلوب للتحويل لـ READER لما معيار محسوب فاشل أو ناقص. */
  acknowledgeRisks?: boolean;
};

export interface OrderRulesResult {
  settings: IntegrationSettings;
  retiredDrafts: number;
  /** طلبات بتستنى التثبيت لما رجعنا عن READER — بتحتاج موظف. */
  awaitingOrders: number;
}

const RULE_KEYS = ["orderMode", "orderSettleMinutes", "orderAutoSeal", "orderAgreementPolicy", "orderConfirmMessage"] as const;

export async function changeOrderRules(
  db: Db,
  ctx: { userId: string; workspaceId: string; role?: string },
  patch: OrderRulesPatch
): Promise<OrderRulesResult> {
  const { confirmReviewed, acknowledgeRisks, ...rest } = patch;
  const parsed = integrationSettingsSchema.pick({ orderMode: true, orderSettleMinutes: true, orderAutoSeal: true, orderAgreementPolicy: true, orderConfirmMessage: true }).partial().parse(rest);
  const current = await getIntegrationSettings(db, ctx.workspaceId);
  const modeChanging = parsed.orderMode !== undefined && parsed.orderMode !== current.orderMode;

  // تغيير الوضع قرار المالك (قاعدة AGENTS: أي تفعيل إنتاجي = المالك بيكبس).
  if (modeChanging && !isOwnerRole(ctx.role)) {
    throw new AppError("تغيير وضع قارئ الطلب للمالك فقط", 403, "OWNER_ONLY");
  }

  let retired = 0;
  if (modeChanging && parsed.orderMode === "READER") {
    if (confirmReviewed !== true) throw new AppError("لازم تأكّد إنك راجعت عيّنة المحادثات قبل التفعيل", 422, "REVIEW_CONFIRMATION_REQUIRED");
    const readiness = await shadowReadiness(db, ctx.workspaceId);
    if (!readiness.computedOk && acknowledgeRisks !== true) {
      throw new AppError("معيار القطع ما اكتمل — أكّد إنك فاهم المخاطر أو كمّل الظل", 422, "READINESS_NOT_MET");
    }
    retired = await retireOpenDrafts(db, ctx.workspaceId, ctx.userId);
  }

  const next = { ...current, ...parsed };
  if (Object.keys(parsed).length > 0) {
    await (db as unknown as { workspace: { update: (a: unknown) => Promise<unknown> } }).workspace.update({
      where: { id: ctx.workspaceId },
      data: { integrationSettings: next as never },
    });
    await recordAudit(db as never, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: modeChanging ? "order_reader.mode_changed" : "order_reader.rules_updated",
      entityType: "Workspace",
      entityId: ctx.workspaceId,
      metadata: {
        changed: RULE_KEYS.filter((k) => parsed[k] !== undefined),
        ...(modeChanging ? { from: current.orderMode, to: parsed.orderMode, retiredDrafts: retired, acknowledgedRisks: acknowledgeRisks === true } : {}),
      },
    });
  }

  let awaiting = 0;
  if (modeChanging && current.orderMode === "READER" && parsed.orderMode !== "READER") {
    const rows = (await (db as unknown as M).order.findMany({
      where: { workspaceId: ctx.workspaceId, status: { in: ["NEW", "CONFIRMATION_PENDING"] }, sealedAt: null, draftId: null },
      select: { id: true },
      take: 2000,
    })) as Row[];
    awaiting = rows.length;
  }
  return { settings: next, retiredDrafts: retired, awaitingOrders: awaiting };
}
