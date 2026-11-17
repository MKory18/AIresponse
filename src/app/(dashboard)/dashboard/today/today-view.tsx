"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Can } from "@/components/auth/permissions";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { CountBadge } from "@/components/ui/count-badge";
import { SetupChecklist } from "@/components/setup-checklist";
import { AttentionPanelView } from "@/components/attention/attention-panel";
import { useAttention } from "@/components/attention/use-attention";
import type { TodayRange } from "@/modules/today/range";
import { MetricCard } from "./metric-card";
import { RecentList, SettlingList } from "./lists";
import { TODAY_STRINGS as S } from "./strings";
import { useToday } from "./use-today";

function Panel({ title, badge, children }: { title: string; badge?: number; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface-2 shadow-raised">
      <h2 className="flex items-center gap-2 border-b border-line px-5 py-3 text-base font-semibold text-ink">
        {title}
        {badge !== undefined && <CountBadge count={badge} />}
      </h2>
      {children}
    </section>
  );
}

/**
 * «اليوم» (3.3، 03 §5.1): شو لازم أعمل هلأ؟ وكيف ماشي اليوم؟ — «يحتاجك الآن» فوق، 4 أرقام بقاعدة احتسابها،
 * «بتتثبّت هلأ» و«آخر الطلبات». محتواه حسب الصلاحية (الخادم بيفلتر «يحتاجك»)، و«ابدأ من هون» للمالك.
 */
export function TodayView() {
  const [range, setRange] = useState<TodayRange>("today");
  const { data, error, loading, reload } = useToday(range);
  const attention = useAttention();
  const top = attention.data.items.slice(0, 5);

  return (
    <div data-today className="mx-auto max-w-6xl space-y-4">
      <div className="flex justify-end">
        <SegmentedControl<TodayRange> label="الفترة" value={range} onChange={setRange} options={S.ranges as unknown as { value: TodayRange; label: string }[]} />
      </div>

      <Can permission="settings.manage">
        <SetupChecklist />
      </Can>

      <Panel title={S.needsYou} badge={attention.data.counts.total}>
        <AttentionPanelView items={top} />
        {attention.data.items.length > top.length && (
          <p className="border-t border-line px-5 py-2 text-caption text-ink-muted">و{attention.data.items.length - top.length} بنود تانية — من زر «يحتاجك» بالأعلى.</p>
        )}
      </Panel>

      {error && !data && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-ink">
          <span>{S.loadError}: {error}</span>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            {S.retry}
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading && !data
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)
          : data?.metrics.map((m) => <MetricCard key={m.key} metric={m} prevLabel={data.prevLabel} />)}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={S.settling} badge={data?.settling.length}>
          {loading && !data ? <Skeleton className="m-5 h-16" /> : <SettlingList rows={data?.settling ?? []} />}
        </Panel>
        <Panel title={S.recent}>{loading && !data ? <Skeleton className="m-5 h-16" /> : <RecentList rows={data?.recent ?? []} />}</Panel>
      </div>
    </div>
  );
}
