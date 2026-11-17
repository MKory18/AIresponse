import { z } from "zod";
import { resolveRange } from "@/core/analytics/time";
import type { Permission } from "@/modules/rbac/permissions";
import { startOfDayInZone } from "@/modules/today/range";
import { kpisForTab, computeKpi, type KpiTab, type KpiValue } from "./kpi-catalog";
import { loadReportData } from "./report-loader";
import type { ReportData } from "./report-data";

/**
 * التقارير (3.7): تبويبات المبيعات · المحادثات · الوكيل · الفريق. منطقة الأيام = `Workspace.timezone` (مش UTC، L-19)،
 * والأرقام والرسمة حيّة من الجداول (اليوم الحالي كامل بلا إعادة بناء، L-18). المقارنة = نافذة بنفس الطول قبل الفترة.
 */

export const reportQuerySchema = z.object({
  tab: z.enum(["sales", "conversations", "agent", "team"]).default("sales"),
  range: z.enum(["today", "yesterday", "last_7_days", "last_30_days", "custom"]).default("last_7_days"),
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
  compare: z.enum(["0", "1"]).optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

type Can = (permission: Permission) => boolean;
type Delegate = { findUnique(a: unknown): Promise<Record<string, unknown> | null> };

export interface KpiOut {
  key: string;
  label: string;
  formula: string;
  value: KpiValue;
  /** قيمة الفترة السابقة (للأرقام المفردة بس، لما تكون المقارنة شغّالة). */
  previous?: KpiValue;
  /** الفرق عن الفترة السابقة (نقاط للنسب، عدد/دقايق للباقي). null = ما في أساس للمقارنة. */
  delta?: number | null;
}

export interface ReportResponse {
  tab: KpiTab;
  range: { start: string; end: string; timezone: string };
  previousRange?: { start: string; end: string };
  kpis: KpiOut[];
  series: { label: string; points: Array<{ date: string; value: number }> };
}

const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

/** أيام الفترة بمنطقة المساحة (مفتاح كل يوم `YYYY-MM-DD`). */
export function dayKeys(start: Date, end: Date, tz: string): string[] {
  const out: string[] = [];
  let cur = startOfDayInZone(start, tz);
  for (let i = 0; i < 400 && cur.getTime() < end.getTime(); i++) {
    out.push(dayKey(cur, tz));
    cur = startOfDayInZone(new Date(cur.getTime() + 36 * 3_600_000), tz);
  }
  return out;
}

function bucket(times: Date[], keys: string[], tz: string): Array<{ date: string; value: number }> {
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const t of times) {
    const k = dayKey(t, tz);
    if (counts.has(k)) counts.set(k, counts.get(k)! + 1);
  }
  return keys.map((date) => ({ date, value: counts.get(date) ?? 0 }));
}

/** رسمة التبويب (واحدة): مبيعات = طلبات مثبّتة باليوم · محادثات = جديدة · وكيل = ردوده · فريق = ردود الموظفين. */
export function seriesFor(tab: KpiTab, d: ReportData): ReportResponse["series"] {
  const keys = dayKeys(d.start, d.end, d.timezone);
  switch (tab) {
    case "sales":
      return { label: "طلبات مثبّتة باليوم", points: bucket(d.sealed.map((o) => o.sealedAt ?? o.createdAt), keys, d.timezone) };
    case "conversations":
      return { label: "محادثات جديدة باليوم", points: bucket(d.conversations.map((c) => c.createdAt), keys, d.timezone) };
    case "agent":
      return { label: "ردود الوكيل باليوم", points: bucket(d.agentReplyTimes, keys, d.timezone) };
    default:
      return { label: "ردود الموظفين باليوم", points: bucket(d.staffReplyTimes, keys, d.timezone) };
  }
}

function scalarNumber(v: KpiValue): number | null {
  if (v.kind === "count") return v.value;
  if (v.kind === "percent" || v.kind === "minutes") return v.value;
  return null;
}

export async function workspaceTimezone(db: unknown, workspaceId: string): Promise<string> {
  const ws = await (db as { workspace: Delegate }).workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  return typeof ws?.timezone === "string" && ws.timezone ? ws.timezone : "UTC";
}

/** الفترة بمنطقة المساحة: الفترات الجاهزة من `resolveRange`، والمخصصة من تاريخين (بحد أقصى 92 يومًا). */
export function resolveReportRange(q: Pick<ReportQuery, "range" | "from" | "to">, timezone: string): { start: Date; end: Date } {
  if (q.range === "custom" && q.from && q.to) {
    // التاريخان `YYYY-MM-DD` بمنطقة المساحة: من بداية يوم «من» لبداية اليوم اللي بعد «إلى».
    const day = (s: string) => startOfDayInZone(new Date(`${s.slice(0, 10)}T12:00:00Z`), timezone);
    const start = day(q.from);
    const end = startOfDayInZone(new Date(day(q.to).getTime() + 36 * 3_600_000), timezone);
    // resolveRange بيتحقق (تاريخ صالح · ترتيب · حد 92 يومًا) وبيرمي INVALID_RANGE.
    return resolveRange({ range: "custom", from: start.toISOString(), to: end.toISOString(), timezone });
  }
  const r = resolveRange({ range: q.range === "custom" ? "last_7_days" : q.range, timezone });
  return { start: r.start, end: r.end };
}

export async function getReport(db: unknown, workspaceId: string, q: ReportQuery, can: Can, now: Date = new Date()): Promise<ReportResponse> {
  const timezone = await workspaceTimezone(db, workspaceId);
  const { start, end } = resolveReportRange(q, timezone);
  const withTeam = q.tab === "team" && can("analytics.agents");
  const cur = await loadReportData(db, workspaceId, { start, end, timezone, now, withTeam });

  const len = end.getTime() - start.getTime();
  const prevRange = q.compare === "1" ? { start: new Date(start.getTime() - len), end: start } : undefined;
  const prev = prevRange ? await loadReportData(db, workspaceId, { ...prevRange, timezone, now: start, withTeam: false }) : null;

  const kpis: KpiOut[] = kpisForTab(q.tab).map((def) => {
    if (def.permission && !can(def.permission)) {
      return { key: def.key, label: def.label, formula: def.formula, value: { kind: "unavailable", reason: "بتحتاج صلاحية إضافية لهالرقم." } };
    }
    const value = computeKpi(def, cur);
    const out: KpiOut = { key: def.key, label: def.label, formula: def.formula, value };
    if (prev) {
      const previous = computeKpi(def, prev);
      const a = scalarNumber(value);
      const b = scalarNumber(previous);
      out.previous = previous;
      out.delta = a === null || b === null ? null : Math.round((a - b) * 10) / 10;
    }
    return out;
  });
  return {
    tab: q.tab,
    range: { start: start.toISOString(), end: end.toISOString(), timezone },
    ...(prevRange ? { previousRange: { start: prevRange.start.toISOString(), end: prevRange.end.toISOString() } } : {}),
    kpis,
    series: seriesFor(q.tab, cur),
  };
}

/** تصدير CSV: نفس القيم (من الكتالوج) — عمود لكل من: القسم · المؤشر · القيمة · العملة · المعادلة. */
export function exportRows(report: ReportResponse): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const k of report.kpis) {
    const v = k.value;
    switch (v.kind) {
      case "count":
        rows.push({ section: k.label, metric: k.label, value: v.value, currency: "", formula: k.formula });
        break;
      case "percent":
        rows.push({ section: k.label, metric: k.label, value: v.value === null ? "" : Math.round(v.value * 10) / 10, currency: "%", formula: k.formula });
        break;
      case "minutes":
        rows.push({ section: k.label, metric: k.label, value: v.value === null ? "" : Math.round(v.value * 10) / 10, currency: "دقيقة", formula: k.formula });
        break;
      case "money":
        if (v.value.length === 0) rows.push({ section: k.label, metric: k.label, value: "", currency: "", formula: k.formula });
        for (const l of v.value) rows.push({ section: k.label, metric: k.label, value: l.value, currency: l.currency, formula: k.formula });
        break;
      case "rows": {
        const [first, ...rest] = v.columns;
        for (const r of v.rows) {
          for (const c of rest) {
            const cell = r[c.key];
            if (typeof cell === "number" || cell === null) rows.push({ section: k.label, metric: `${r[first!.key]} · ${c.label}`, value: cell ?? "", currency: typeof r.currency === "string" ? r.currency : "", formula: k.formula });
          }
        }
        break;
      }
      default:
        rows.push({ section: k.label, metric: k.label, value: "", currency: "", formula: `غير متاح: ${v.reason}` });
    }
  }
  return rows;
}

