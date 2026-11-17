/**
 * نموذج «التقارير» (3.7) — دوال صرفة: التبويب من الرابط (والروابط القديمة بتتحوّل للتبويب المناسب) ·
 * الفترة · نص الاستعلام · تنسيق الدقايق.
 */
export type ReportTab = "sales" | "conversations" | "agent" | "team";
export type RangeKey = "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";

export const TABS: ReadonlyArray<{ value: ReportTab; label: string }> = [
  { value: "sales", label: "المبيعات" },
  { value: "conversations", label: "المحادثات" },
  { value: "agent", label: "الوكيل" },
  { value: "team", label: "الفريق" },
];

/**
 * الروابط القديمة (`?tab=`): نظرة عامة (مكررة مع «اليوم») · المنتجات ← المبيعات · الذكاء ← الوكيل ·
 * الاتجاهات (صارت رسمة بكل تبويب) · الموظفون ← الفريق · الحملات والأتمتة (ميزات مخفية) ← المبيعات.
 */
const LEGACY_TABS: Record<string, ReportTab> = {
  exec: "sales",
  overview: "sales",
  sales: "sales",
  products: "sales",
  trends: "sales",
  campaigns: "sales",
  automation: "sales",
  conversations: "conversations",
  ai: "agent",
  agent: "agent",
  agents: "team",
  team: "team",
};

export function resolveTab(raw: string | null | undefined): ReportTab {
  return (raw && LEGACY_TABS[raw]) || "sales";
}

export function parseRange(raw: string | null | undefined): RangeKey {
  return ["today", "yesterday", "last_7_days", "last_30_days", "custom"].includes(String(raw)) ? (raw as RangeKey) : "last_7_days";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportParams {
  tab: ReportTab;
  range: RangeKey;
  from?: string;
  to?: string;
  compare?: boolean;
}

/** نص الاستعلام لـ`/api/reports` و`/api/reports/export`. «مخصص» بلا تاريخين صالحين بيرجع لآخر 7 أيام. */
export function reportQuery(p: ReportParams): string {
  const q = new URLSearchParams({ tab: p.tab });
  if (p.range === "custom" && p.from && p.to && DATE.test(p.from) && DATE.test(p.to)) {
    q.set("range", "custom");
    q.set("from", p.from);
    q.set("to", p.to);
  } else q.set("range", p.range === "custom" ? "last_7_days" : p.range);
  if (p.compare) q.set("compare", "1");
  return q.toString();
}

/** «45 د» · «2 س 5 د» · «3 يوم». */
export function minutesText(value: number): string {
  const m = Math.round(value);
  if (m < 60) return `${m} د`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} س${m % 60 ? ` ${m % 60} د` : ""}`;
  return `${Math.round(m / 60 / 24)} يوم`;
}
