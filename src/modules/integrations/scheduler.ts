import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { deliverDueIntegrations } from "./outbox";
import { evaluateCapacityAlerts } from "./capacity";
import {
  enqueueChannelHealthAlerts,
  enqueueDailyUsageReport,
  enqueueOverdueHandoffTask,
  enqueueWeeklyQuestionsIdea,
} from "./ops-signals";
import { emitRetargetResult, sweepUnverifiedCodes } from "./clipper";
import { sweepStuckOmsHandoffs } from "@/modules/oms/auto-handoff";
import { timezoneOffsetMinutes } from "@/core/analytics/time";

/**
 * P12 — مجدول الربط (يُستدعى من حلقة العامل كل دورة):
 * - كل دورة: إرسال المستحق من صندوق الصادر.
 * - كل 5 دقايق: تقييم قدرة الرد وإنذاراتها (للمساحات المربوطة فقط).
 * - كل ساعة: تقرير التكاليف اليومي · صحة القنوات · التحويلات المتأخرة ·
 *   فكرة الأسبوع · إعادة قراءة قواعد الامتثال القديمة · نتائج الحملات النهائية ·
 *   كنس الترحيل التلقائي للـ OMS وتحقق الرموز الي فشلت بانقطاع.
 * كل مهمة idempotent بمفاتيحها (يوم/ساعة/أسبوع) — عاملين بنفس الوقت ما بيكرروا.
 */

const log = childLogger("integrations.scheduler");

const lastRun = new Map<string, number>();
const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;
export const RETARGET_FINAL_AFTER_HOURS = 72;

function due(key: string, every: number, now: number): boolean {
  const prev = lastRun.get(key) ?? 0;
  if (now - prev < every) return false;
  lastRun.set(key, now);
  return true;
}

/** للاختبارات: يصفّر مواقيت التشغيل. */
export function resetIntegrationScheduler(): void {
  lastRun.clear();
}

type ConnRow = { workspaceId: string; system: string; enabled: boolean };

function localHour(now: Date, timezone: string): { hour: number; weekday: number } {
  const shifted = new Date(now.getTime() + timezoneOffsetMinutes(timezone, now) * 60_000);
  return { hour: shifted.getUTCHours(), weekday: shifted.getUTCDay() };
}

export async function runIntegrationScheduler(db: Db, now = new Date()): Promise<void> {
  const t = now.getTime();
  try {
    await deliverDueIntegrations(db, { limit: 25, now });
  } catch (err) {
    log.error({ err }, "integration_deliveries_failed");
  }

  const fiveMin = due("capacity", FIVE_MIN, t);
  const hourly = due("hourly", HOUR, t);
  if (!fiveMin && !hourly) return;

  // الـ OMS بجدوله الخاص (مش IntegrationConnection): ترحيل تلقائي فشل لأن الـ
  // OMS كان واقف ← إعادة بنفس المفتاح.
  if (hourly) await sweepStuckOmsHandoffs(db, now).catch((err) => log.error({ err }, "oms_handoff_sweep_failed"));

  // مدة الاحتفاظ بوسائط الزبون الواردة: كنس عام (الوسيط مربوط برسالته،
  // مش بمساحة مربوطة بنظام) — بيحذف الملف والصف ويختم الرسالة بعلامة.
  if (hourly) {
    const { purgeOldCustomerMedia } = await import("@/modules/channels/whatsapp/media-retention");
    await purgeOldCustomerMedia(db, now).catch((err) => log.error({ err }, "wa_media_purge_failed"));
  }

  const conns = (await (db as unknown as { integrationConnection?: { findMany: (a: unknown) => Promise<unknown> } }).integrationConnection?.findMany({
    where: { enabled: true },
    select: { workspaceId: true, system: true, enabled: true },
  })) as ConnRow[] | undefined;
  const bySpace = new Map<string, Set<string>>();
  for (const c of conns ?? []) {
    const set = bySpace.get(c.workspaceId) ?? new Set<string>();
    set.add(c.system);
    bySpace.set(c.workspaceId, set);
  }

  for (const [workspaceId, systems] of bySpace) {
    if (fiveMin && (systems.has("mediabuyer") || systems.has("bridge") || systems.has("crisis"))) {
      await evaluateCapacityAlerts(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "capacity_eval_failed"));
    }
    if (!hourly) continue;
    const ws = (await db.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } })) as { timezone?: string } | null;
    const { hour, weekday } = localHour(now, ws?.timezone || "UTC");
    if (systems.has("finance") && hour >= 1) {
      await enqueueDailyUsageReport(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "usage_report_failed"));
    }
    if (systems.has("crisis")) {
      await enqueueChannelHealthAlerts(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "channel_alerts_failed"));
    }
    if (systems.has("tasks") && hour >= 9 && hour < 22) {
      await enqueueOverdueHandoffTask(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "handoff_task_failed"));
    }
    if (systems.has("workspace") && weekday === 0 && hour >= 9) {
      await enqueueWeeklyQuestionsIdea(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "weekly_idea_failed"));
    }
    if (systems.has("s1")) {
      await refreshStaleCompliance(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "compliance_refresh_failed"));
    }
    if (systems.has("clipper")) {
      await sendFinalRetargetResults(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "retarget_final_failed"));
      await sweepUnverifiedCodes(db, workspaceId, now).catch((err) => log.error({ err, workspaceId }, "code_sweep_failed"));
    }
  }
}

/** منتجات مربوطة بسيستم 1 ونسختها أقدم من 24 ساعة (أو بلا نسخة) → مهمة إعادة قراءة. */
async function refreshStaleCompliance(db: Db, workspaceId: string, now: Date): Promise<number> {
  const products = (await db.product.findMany({
    where: { workspaceId, isActive: true, s1ProductRef: { not: null } } as never,
    select: { id: true },
    take: 200,
  })) as Array<{ id: string }>;
  if (!products.length) return 0;
  const rows = (await (db as unknown as { productCompliance: { findMany: (a: unknown) => Promise<unknown> } }).productCompliance.findMany({
    where: { productId: { in: products.map((p) => p.id) } },
    select: { productId: true, fetchedAt: true },
  })) as Array<{ productId: string; fetchedAt: Date | string | null }>;
  const fresh = new Set(rows.filter((r) => r.fetchedAt && now.getTime() - new Date(r.fetchedAt).getTime() < 24 * HOUR).map((r) => r.productId));
  const { enqueueJob } = await import("@/modules/jobs/service");
  const day = now.toISOString().slice(0, 10);
  let n = 0;
  for (const p of products) {
    if (fresh.has(p.id)) continue;
    await enqueueJob(db, {
      workspaceId,
      type: "refresh_product_compliance",
      payload: { productId: p.id },
      idempotencyKey: `compliance-daily:${p.id}:${day}`,
    });
    n += 1;
    if (n >= 50) break;
  }
  return n;
}

/** النتيجة النهائية لحملات الكليبر بعد 72 ساعة من انتهائها (الردود والطلبات تكون وصلت). */
async function sendFinalRetargetResults(db: Db, workspaceId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETARGET_FINAL_AFTER_HOURS * HOUR);
  const campaigns = (await db.campaign.findMany({
    where: {
      workspaceId,
      externalSystem: "clipper",
      finalResultsSentAt: null,
      status: { in: ["COMPLETED", "CANCELLED", "FAILED"] },
      updatedAt: { lt: cutoff },
    } as never,
    select: { id: true },
    take: 20,
  })) as Array<{ id: string }>;
  let n = 0;
  for (const c of campaigns) if (await emitRetargetResult(db, c.id, true)) n += 1;
  return n;
}
