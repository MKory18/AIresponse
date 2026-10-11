import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { dateInZone, decimalString, opaqueTag } from "./format";
import { enqueueSystemCall } from "./outbox";
import { getIntegrationSettings } from "./settings";
import { timezoneOffsetMinutes } from "@/core/analytics/time";

/**
 * P12 — إشارات تشغيلية للأنظمة الأخرى عبر صندوق الصادر (بلا بيانات شخصية):
 * - المالية: تقرير يومي بتكاليف الموديلات والسيرفر (POST /api/v1/usage-costs).
 * - الأزمات: توكن قناة انتهى أو قرب ينتهي (POST /api/v1/alerts).
 * - المهام: تحويلات بشرية متأخرة (POST /api/v1/tasks) — مرة باليوم.
 * - مساحة العمل: أكثر أسئلة الزبائن بالأسبوع (POST /api/v1/ideas).
 * كل نداء بمفتاح عدم تكرار ثابت (وسم المساحة + يوم/أسبوع) — الإعادة لا تكرر
 * عند المستقبِل، ومساحتين بنفس النظام ما بيتصادموا.
 */

const log = childLogger("integrations.ops");

/** بداية ونهاية يوم معيّن بمنطقة مساحة العمل (UTC instants). */
export function zonedDayRange(day: string, timezone: string): { start: Date; end: Date } {
  const [y, m, d] = day.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const offset = timezoneOffsetMinutes(timezone, guess);
  const start = new Date(guess.getTime() - offset * 60_000);
  const nextGuess = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  const offset2 = timezoneOffsetMinutes(timezone, nextGuess);
  const end = new Date(nextGuess.getTime() - offset2 * 60_000);
  return { start, end };
}

/** تقرير تكاليف يوم (افتراضي: مبارح بمنطقة المساحة). يرجّع true إذا انكتب. */
export async function enqueueDailyUsageReport(db: Db, workspaceId: string, now = new Date(), dayOverride?: string): Promise<boolean> {
  const ws = (await db.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } })) as { timezone?: string } | null;
  const tz = ws?.timezone || "UTC";
  const day = dayOverride ?? dateInZone(new Date(now.getTime() - 24 * 3600_000), tz);
  const { start, end } = zonedDayRange(day, tz);
  const logs = (await db.aIUsageLog.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    select: { provider: true, costUsd: true },
  })) as Array<{ provider: string; costUsd: number | null }>;
  const byProvider = new Map<string, number>();
  let unknownPriced = 0;
  for (const l of logs) {
    if (l.costUsd === null || l.costUsd === undefined) {
      unknownPriced += 1;
      continue;
    }
    byProvider.set(l.provider, (byProvider.get(l.provider) ?? 0) + Number(l.costUsd));
  }
  const items: Array<{ kind: string; provider: string; amount: string; currency: string }> = [];
  for (const [provider, amount] of byProvider) {
    const a = decimalString(amount);
    if (a && Number(a) > 0) items.push({ kind: "model_api", provider: provider.slice(0, 40), amount: a, currency: "USD" });
  }
  const settings = await getIntegrationSettings(db, workspaceId);
  if (settings.serverCostUsdPerDay && Number(settings.serverCostUsdPerDay) > 0) {
    items.push({ kind: "server", provider: "main", amount: settings.serverCostUsdPerDay, currency: "USD" });
  }
  if (unknownPriced > 0) log.warn({ workspaceId, day, unknownPriced }, "usage_report_unpriced_calls");
  if (items.length === 0) return false; // لا تكلفة معروفة = لا قيد صفري مخترع
  return enqueueSystemCall(db, {
    workspaceId,
    system: "finance",
    type: "usage-costs",
    path: "/api/v1/usage-costs",
    body: { system: "replies", date: day, items },
    // وسم المساحة بالمفتاح: مساحتين بنفس شركة المالية ما بيبلعوا تقرير بعض.
    idempotencyKey: `replies-usage-${opaqueTag("workspace", workspaceId)}-${day}`,
    dedupeKey: day,
  });
}

/** توكنات قنوات منتهية أو تنتهي خلال 72 ساعة → إنذار للأزمات (مرة باليوم لكل قناة). */
export async function enqueueChannelHealthAlerts(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const channels = (await db.channel.findMany({
    where: { workspaceId, status: "CONNECTED" },
    select: { id: true, type: true },
  })) as Array<{ id: string; type: string }>;
  if (!channels.length) return 0;
  const accounts = (await db.channelAccount.findMany({
    where: { channelId: { in: channels.map((c) => c.id) } },
    select: { channelId: true, tokenExpiresAt: true },
  })) as Array<{ channelId: string; tokenExpiresAt: Date | string | null }>;
  const day = now.toISOString().slice(0, 10);
  let n = 0;
  for (const a of accounts) {
    if (!a.tokenExpiresAt) continue;
    const exp = new Date(a.tokenExpiresAt).getTime();
    const hoursLeft = (exp - now.getTime()) / 3600_000;
    if (hoursLeft > 72) continue;
    const type = channels.find((c) => c.id === a.channelId)?.type ?? "CHANNEL";
    const expired = hoursLeft <= 0;
    const ref = `rep-ch-${opaqueTag("channel", a.channelId, 8)}-${day}`;
    const ok = await enqueueSystemCall(db, {
      workspaceId,
      system: "crisis",
      type: "alerts",
      path: "/api/v1/alerts",
      body: {
        external_ref: ref,
        type: expired ? "replies_channel_token_expired" : "replies_channel_token_expiring",
        severity: expired ? "high" : "medium",
        channel: type.toLowerCase(),
        message: expired
          ? `قناة ${type} انتهى توكنها — الردود عليها واقفة لحد إعادة الربط`
          : `قناة ${type} توكنها بينتهي خلال ${Math.max(1, Math.round(hoursLeft))} ساعة — جدّد الربط`,
      },
      idempotencyKey: ref,
      dedupeKey: `${a.channelId}:${day}`,
    });
    if (ok) n += 1;
  }
  return n;
}

/** تحويلات بشرية مفتوحة أقدم من مهلة الحل → مهمة واحدة باليوم للمشرف. */
export async function enqueueOverdueHandoffTask(db: Db, workspaceId: string, now = new Date()): Promise<boolean> {
  const ws = (await db.workspace.findUnique({ where: { id: workspaceId }, select: { slaHandoffResolutionMinutes: true, timezone: true } })) as
    | { slaHandoffResolutionMinutes?: number | null; timezone?: string }
    | null;
  const slaMin = ws?.slaHandoffResolutionMinutes ?? 60;
  const overdue = await db.humanHandoff.count({
    where: { workspaceId, status: "OPEN", createdAt: { lt: new Date(now.getTime() - slaMin * 60_000) } } as never,
  });
  if (overdue === 0) return false;
  const day = dateInZone(now, ws?.timezone);
  const ref = `rep-handoff-${opaqueTag("workspace", workspaceId)}-${day}`;
  return enqueueSystemCall(db, {
    workspaceId,
    system: "tasks",
    type: "tasks",
    path: "/api/v1/tasks",
    body: {
      external_ref: ref,
      title: `تحويلات بشرية متأخرة بالردود: ${overdue} محادثة بانتظار موظف أكثر من ${slaMin} دقيقة`,
      assignee_role: "support_lead",
      due: day,
    },
    idempotencyKey: ref,
    dedupeKey: `handoff:${day}`,
  });
}

const INTENT_AR: Record<string, string> = {
  PRICE_QUESTION: "السعر",
  DELIVERY_QUESTION: "التوصيل",
  HOW_TO_USE: "طريقة الاستخدام",
  BENEFITS: "الفوائد",
  AVAILABILITY: "التوفر",
  PRODUCT_QUESTION: "أسئلة المنتج",
  PRODUCT_COMPARISON: "المقارنة",
  PAYMENT_QUESTION: "الدفع",
  RETURN_REQUEST: "الإرجاع",
  COMPLAINT: "الشكاوى",
  TRACK_ORDER: "تتبع الطلب",
  ORDER_CANCEL: "إلغاء الطلب",
};

/** فكرة أسبوعية لمساحة العمل من أكثر مواضيع الأسئلة (أعداد فقط — بلا نص زبون). */
export async function enqueueWeeklyQuestionsIdea(db: Db, workspaceId: string, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - 7 * 24 * 3600_000);
  const logs = (await db.aIUsageLog.findMany({
    where: { workspaceId, createdAt: { gte: since }, intent: { not: null } } as never,
    select: { intent: true, messageId: true },
  })) as Array<{ intent: string | null; messageId: string | null }>;
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const l of logs) {
    if (!l.intent || !INTENT_AR[l.intent]) continue;
    const key = `${l.messageId ?? Math.random()}:${l.intent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(l.intent, (counts.get(l.intent) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) return false;
  const week = `${now.getUTCFullYear()}-w${Math.ceil(((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)}`;
  const summary = top.map(([k, v]) => `${INTENT_AR[k]} ${v}`).join(" · ");
  const ref = `rep-idea-${opaqueTag("workspace", workspaceId)}-${week}`;
  return enqueueSystemCall(db, {
    workspaceId,
    system: "workspace",
    type: "ideas",
    path: "/api/v1/ideas",
    body: {
      external_ref: ref,
      title: "أكثر أسئلة الزبائن هالأسبوع — جهّز ردود ومحتوى",
      summary: `مواضيع الأسئلة بالردود آخر 7 أيام: ${summary}`,
      tags: ["الردود", "أسئلة الزبائن"],
    },
    idempotencyKey: ref,
    dedupeKey: `idea:${week}`,
  });
}
