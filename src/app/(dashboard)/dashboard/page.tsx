"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Overview = {
  conversations: { total: number; active: number; resolved: number };
  messages: { inbound: number; outbound: number };
  orders: { created: number; confirmed: number; delivered: number; cancelled: number };
  revenue: { confirmed: number; delivered: number };
  ai: { calls: number; failed: number; tokens: number; estimatedCost: number };
  handoffs: { total: number; open: number; avgResolutionMinutes: number | null };
  automation: { executions: number; completed: number; failed: number; skipped: number };
};

const RANGES: [string, string][] = [
  ["today", "اليوم"], ["yesterday", "أمس"], ["last_7_days", "آخر 7 أيام"], ["last_30_days", "آخر 30 يومًا"],
];

function Card({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">
        {value === null || value === undefined ? "—" : typeof value === "number" ? Math.round(value * 100) / 100 : value}
      </p>
    </div>
  );
}

function Section({ title, link, children }: { title: string; link?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-700">{title}</h2>
        {link && <Link href={link} className="text-xs text-brand-600 hover:underline">التفاصيل ←</Link>}
      </div>
      {children}
    </section>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [range, setRange] = useState("last_7_days");
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ range, timezone });
    const res = await fetch(`/api/analytics/overview?${params}`);
    if (!res.ok) {
      setError("فشل تحميل التحليلات");
      setLoading(false);
      return;
    }
    setData(await res.json());
    setError(null);
    setLoading(false);
  }, [range, timezone]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">نظرة عامة</h1>
        <div className="flex gap-2">
          <select value={range} onChange={(e) => setRange(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {["UTC", "Asia/Damascus", "Asia/Riyadh", "Asia/Dubai", "Africa/Cairo"].map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}

      {data && (
        <div className="space-y-4">
          <Section title="المبيعات">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="طلبات مؤكدة" value={data.orders.confirmed} />
              <Card label="طلبات مُسلّمة" value={data.orders.delivered} />
              <Card label="إيرادات مؤكدة" value={data.revenue.confirmed} />
              <Card label="إيرادات مُسلّمة" value={data.revenue.delivered} />
            </div>
          </Section>

          <Section title="المحادثات">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="محادثات جديدة" value={data.conversations.total} />
              <Card label="نشطة" value={data.conversations.active} />
              <Card label="رسائل واردة" value={data.messages.inbound} />
              <Card label="رسائل صادرة" value={data.messages.outbound} />
            </div>
          </Section>

          <Section title="AI" link="/ai/playground">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="استدعاءات AI" value={data.ai.calls} />
              <Card label="فشل AI" value={data.ai.failed} />
              <Card label="Tokens" value={data.ai.tokens} />
              <Card label="التكلفة التقديرية" value={data.ai.estimatedCost} />
            </div>
          </Section>

          <Section title="الدعم البشري" link="/handoffs">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="تحويلات مفتوحة" value={data.handoffs.open} />
              <Card label="إجمالي التحويلات" value={data.handoffs.total} />
              <Card label="متوسط زمن الحل (د)" value={data.handoffs.avgResolutionMinutes} />
            </div>
          </Section>

          <Section title="الأتمتة" link="/automation">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="تنفيذات" value={data.automation.executions} />
              <Card label="ناجحة" value={data.automation.completed} />
              <Card label="فاشلة" value={data.automation.failed} />
              <Card label="متجاوزة" value={data.automation.skipped} />
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}
