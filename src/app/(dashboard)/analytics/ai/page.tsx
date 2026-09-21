"use client";

import { useCallback, useEffect, useState } from "react";

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
    <div className="mb-2">
      <p className="mb-1 flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums">{value.toLocaleString()}</span>
      </p>
      <div className="h-2 rounded bg-slate-100">
        <div className="h-2 rounded bg-brand-500" style={{ width: `${pct}%` }} />
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

  if (loading) return <p className="text-sm text-slate-400">جارٍ التحميل…</p>;
  if (!data) return <p className="text-sm text-red-600">فشل التحميل</p>;

  const maxTaskCalls = Math.max(1, ...data.byTask.map((t) => t.calls));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">استخدام AI</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["استدعاءات", data.calls],
          ["ناجحة", data.successful],
          ["فاشلة", data.failed],
          ["متوسط الاستجابة (ms)", data.avgLatencyMs],
          ["Input tokens", data.inputTokens],
          ["Output tokens", data.outputTokens],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-bold tabular-nums">{value === null ? "—" : Number(value).toLocaleString()}</p>
          </div>
        ))}
        <div className="rounded-xl border border-slate-200 bg-white p-4 md:col-span-2">
          <p className="text-xs text-slate-500">التكلفة التقديرية</p>
          <p className="mt-1 text-xl font-bold tabular-nums">
            {data.estimatedCost === null ? "غير متاحة (لا يوجد pricing مُعدّ)" : `$${data.estimatedCost.toFixed(4)}`}
          </p>
        </div>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-slate-700">حسب المهمة</h2>
        {data.byTask.map((t) => <Bar key={t.key} label={t.key} value={t.calls} max={maxTaskCalls} />)}
        {data.byTask.length === 0 && <p className="text-xs text-slate-400">لا توجد بيانات.</p>}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-slate-700">حسب النموذج</h2>
        {data.byModel.map((m) => (
          <div key={m.key} className="mb-2 flex justify-between text-xs text-slate-600" dir="ltr">
            <span>{m.key}</span>
            <span>{m.calls} calls · {m.inputTokens + m.outputTokens} tokens</span>
          </div>
        ))}
        {data.byModel.length === 0 && <p className="text-xs text-slate-400">لا توجد بيانات.</p>}
      </section>
    </div>
  );
}
