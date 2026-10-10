import { enqueueJob } from "@/modules/jobs/service";
import { resolveRange, type RangeQuery } from "@/core/analytics/time";
import type { Db } from "@/modules/customers/service";

/**
 * P10 — الاتجاهات الزمنية: تُقرأ من DailyWorkspaceAnalytics (جدول تجميع يومي
 * موجود منذ P6، يُبنى idempotently من الجداول المصدرية — لا يُبنى شيء جديد).
 *
 * - مفاتيح الأيام: أيام UTC (موثق في aggregation.ts) — تُغطى فترة الاستعلام
 *   بمنطقة المؤسسة عبر resolveRange ثم تُضم أيام UTC المتقاطعة.
 * - يوم بلا صف = بيانات مفقودة (MISSING) — لا يُعرض كصفر.
 * - الإصلاح الذاتي: عند وجود أيام مفقودة/قديمة تُسجَّل مهمة تجميع واحدة
 *   idempotently (مفتاح analytics-rebuild:{ws}) — إصلاح تحليلي داخلي لا يمس
 *   حالة أي Workflow ولا ينفذ إجراء إنتاجيًا.
 * - staleness: صف يوم اليوم بلا تحديث خلال 6 ساعات = قديم (STALE) — يُعرض
 *   آخر تحديث دائمًا.
 */

const STALE_MS = 6 * 3600_000;

export interface TrendRow {
  date: string;
  dataStatus: "OK" | "STALE";
  conversations: number;
  inboundMessages: number;
  outboundMessages: number;
  aiCalls: number;
  aiTokens: number;
  aiCostUsd: number | null;
  ordersCreated: number;
  ordersConfirmed: number;
  ordersDelivered: number;
  revenueConfirmed: number | null;
  revenueDelivered: number | null;
  handoffs: number;
  automationExecutions: number;
  followUpsSent: number;
}

export async function getTrends(db: Db, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);

  // أيام UTC المتقاطعة مع النافذة (المجمّع اليومي بمفاتيح UTC — موثق)
  const firstDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));

  const rows = await db.dailyWorkspaceAnalytics.findMany({
    where: { workspaceId, date: { gte: firstDay, lte: lastDay } },
    orderBy: { date: "asc" },
  });
  const byDate = new Map(rows.map((r) => [new Date(r.date).toISOString().slice(0, 10), r]));

  const days: string[] = [];
  const cur = new Date(firstDay);
  while (cur.getTime() <= lastDay.getTime()) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const now = Date.now();
  const series: Array<TrendRow | { date: string; dataStatus: "MISSING" }> = [];
  let missing = 0;
  for (const d of days) {
    const row = byDate.get(d);
    if (!row) {
      series.push({ date: d, dataStatus: "MISSING" });
      missing += 1;
      continue;
    }
    const stale = now - new Date(row.updatedAt).getTime() > STALE_MS;
    series.push({
      date: d,
      dataStatus: stale ? "STALE" : "OK",
      conversations: row.conversations,
      inboundMessages: row.inboundMessages,
      outboundMessages: row.outboundMessages,
      aiCalls: row.aiCalls,
      aiTokens: row.aiTokens,
      aiCostUsd: row.aiCostUsd,
      ordersCreated: row.ordersCreated,
      ordersConfirmed: row.ordersConfirmed,
      ordersDelivered: row.ordersDelivered,
      revenueConfirmed: row.revenueConfirmed === null ? null : Number(row.revenueConfirmed),
      revenueDelivered: row.revenueDelivered === null ? null : Number(row.revenueDelivered),
      handoffs: row.handoffs,
      automationExecutions: row.automationExecutions,
      followUpsSent: row.followUpsSent,
    });
  }

  const lastRebuiltAt = rows.length
    ? new Date(Math.max(...rows.map((r) => new Date(r.updatedAt).getTime()))).toISOString()
    : null;

  let rebuildEnqueued = false;
  if (missing > 0) {
    await enqueueJob(db, {
      workspaceId,
      type: "aggregate_workspace_analytics",
      payload: { workspaceId, from: firstDay.toISOString(), to: lastDay.toISOString() },
      runAfter: new Date(),
      idempotencyKey: `analytics-rebuild:${workspaceId}`,
    });
    rebuildEnqueued = true;
  }

  return {
    timezoneNote: "أيام مجمعة على حدود UTC (بنية الجدول اليومي) — الفترة نفسها بمنطقة المؤسسة",
    days,
    series,
    coverage: { totalDays: days.length, missing, rebuildEnqueued, lastRebuiltAt },
  };
}
