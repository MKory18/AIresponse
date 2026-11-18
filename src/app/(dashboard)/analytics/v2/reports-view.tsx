"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { Can, useCan } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "./kpi-card";
import { TABS, parseRange, reportQuery, resolveTab, type RangeKey, type ReportTab } from "./model";
import { RowsTable } from "./rows-table";
import { REPORT_STRINGS as S } from "./strings";
import { TechDetails } from "./tech-details";
import { TrendChart } from "./trend-chart";
import { useReport } from "./use-report";

const FIELD = "rounded-control border border-border-strong bg-surface-2 px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus";

/**
 * «التقارير» (3.7، 03 §5.4 · 05 §5): 4 تبويبات (المبيعات · المحادثات · الوكيل · الفريق) — كل تبويب أرقام من الكتالوج
 * (كلها بـⓘ معادلتها) + رسمة زمنية وحدة + جداول التفصيل. الفترة بمنطقة المساحة، و«قارن بالفترة السابقة» و«تصدير CSV» بنفس الأرقام.
 * الروابط القديمة `?tab=ai|products|overview|trends` بتتحوّل للتبويب المناسب (`model.ts`).
 */
export function ReportsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const can = useCan();
  const tab = resolveTab(params.get("tab"));
  const [range, setRange] = useState<RangeKey>(parseRange(params.get("range")));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [compare, setCompare] = useState(false);

  const customReady = range !== "custom" || (!!from && !!to && from <= to);
  const { data, error, loading, reload, query } = useReport({ tab, range: customReady ? range : "last_7_days", from, to, compare });
  const tabs = useMemo(() => TABS.filter((t) => t.value !== "team" || can("analytics.agents")), [can]);

  function selectTab(next: ReportTab) {
    const q = new URLSearchParams(params.toString());
    q.set("tab", next);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }

  const scalars = data?.kpis.filter((k) => k.value.kind !== "rows") ?? [];
  const tables = data?.kpis.filter((k) => k.value.kind === "rows" || (k.value.kind === "unavailable" && k.key.endsWith("agents"))) ?? [];
  const promises = data?.kpis.find((k) => k.key === "agent.ai_promise");
  const promiseCount = promises && promises.value.kind === "count" ? promises.value.value : 0;

  return (
    <div data-reports-v2 className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<ReportTab> label="التبويب" value={tab} onChange={selectTab} options={tabs} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            {S.period}
            <select aria-label={S.period} value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className={FIELD}>
              {S.ranges.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {range === "custom" && (
            <>
              <input type="date" aria-label={S.from} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={FIELD} />
              <input type="date" aria-label={S.to} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={FIELD} />
            </>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="h-4 w-4 accent-primary" />
            {S.compare}
          </label>
          <a
            href={`/api/reports/export?${reportQuery({ tab, range: customReady ? range : "last_7_days", from, to, compare })}`}
            download
            className="inline-flex items-center gap-1.5 rounded-control border border-border-strong bg-surface-2 px-3 py-2 text-sm font-medium text-ink hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Download size={14} aria-hidden /> {S.export}
          </a>
        </div>
      </div>

      {error && !data && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-ink">
          <span>
            {S.loadError}: {error}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            {S.retry}
          </Button>
        </div>
      )}

      {promiseCount > 0 && (
        <Callout risk={`الوكيل وعد بتثبيت طلب والبيانات ناقصة ${promiseCount} مرة بالفترة`} fix="افتح بنود «يحتاجك» وكمّل البيانات مع العميل، أو صحّح له." />
      )}

      <div className={loading && data ? "space-y-4 opacity-60 transition-opacity" : "space-y-4"} aria-busy={loading}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {loading && !data ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-32" />) : scalars.map((k) => <KpiCard key={k.key} k={k} />)}
        </div>
        {data && <TrendChart label={data.series.label} points={data.series.points} />}
        {tables.map((k) => (
          <RowsTable key={k.key} k={k} />
        ))}
        {data && tab === "agent" && (
          <Can permission="usage.read">
            <TechDetails start={data.range.start} end={data.range.end} timezone={data.range.timezone} />
          </Can>
        )}
        <p className="text-caption text-ink-subtle" data-query hidden>
          {query}
        </p>
      </div>
    </div>
  );
}
