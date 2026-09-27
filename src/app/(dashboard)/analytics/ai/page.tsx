"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Cpu, Timer, Wallet } from "lucide-react";
import { formatNumber, t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { GlassCard, PageHeader } from "@/components/ui/card";

type AIGroup = { key: string; calls: number; inputTokens: number; outputTokens: number; estimatedCost: number | null };
type AIAnalytics = {
  calls: number;
  successful: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number | null;
  avgLatencyMs: number | null;
  byTask: AIGroup[];
  byModel: AIGroup[];
};

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="mb-2.5 last:mb-0">
      <p className="mb-1 flex justify-between text-xs">
        <span className="font-semibold text-ink">{label}</span>
        <span className="num text-ink-muted">{value.toLocaleString()}</span>
      </p>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-gradient-to-l from-brand-400 to-brand-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function AIAnalyticsPage() {
  const [data, setData] = useState<AIAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/analytics/ai?range=last_30_days");
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="page-wrap">
        <PageHeader title="استخدام AI" description="آخر 30 يومًا." />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page-wrap">
        <PageHeader title="استخدام AI" description="آخر 30 يومًا." />
        <GlassCard className="p-2">
          <EmptyState title="فشل التحميل" description="تعذّر تحميل بيانات استخدام AI." action={null} />
        </GlassCard>
      </div>
    );
  }

  const maxTaskCalls = Math.max(1, ...data.byTask.map((item) => item.calls));

  return (
    <div className="page-wrap">
      <PageHeader title="استخدام AI" description="آخر 30 يومًا — الاستدعاءات والنماذج والتكلفة." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="استدعاءات" value={formatNumber(data.calls)} tone="violet" icon={<Bot size={18} />} />
        <StatCard label="ناجحة" value={formatNumber(data.successful)} tone="emerald" />
        <StatCard label="فاشلة" value={formatNumber(data.failed)} tone="red" />
        <StatCard label="متوسط الاستجابة" value={data.avgLatencyMs === null ? "—" : `${formatNumber(data.avgLatencyMs)}ms`} tone="sky" icon={<Timer size={18} />} />
        <StatCard label="Input tokens" value={formatNumber(data.inputTokens)} tone="brand" icon={<Cpu size={18} />} />
        <StatCard label="Output tokens" value={formatNumber(data.outputTokens)} tone="brand" />
        <StatCard
          label="التكلفة التقديرية"
          value={data.estimatedCost === null ? "غير متاحة" : `$${data.estimatedCost.toFixed(4)}`}
          hint={data.estimatedCost === null ? "لا يوجد pricing مُعدّ" : undefined}
          tone="amber"
          icon={<Wallet size={18} />}
          className="col-span-2"
        />
      </div>

      <GlassCard className="p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-bold text-ink">حسب المهمة</h2>
        {data.byTask.map((item) => <Bar key={item.key} label={item.key} value={item.calls} max={maxTaskCalls} />)}
        {data.byTask.length === 0 && <p className="text-xs text-ink-subtle">{t.common.noData}.</p>}
      </GlassCard>

      <GlassCard className="p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-bold text-ink">حسب النموذج</h2>
        <div className="space-y-1.5">
          {data.byModel.map((m) => (
            <div key={m.key} className="glass-subtle flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs">
              <Badge className="num" dir="ltr">{m.key}</Badge>
              <span className="num text-ink-muted">{m.calls} calls · {m.inputTokens + m.outputTokens} tokens</span>
            </div>
          ))}
        </div>
        {data.byModel.length === 0 && <p className="text-xs text-ink-subtle">{t.common.noData}.</p>}
      </GlassCard>
    </div>
  );
}
