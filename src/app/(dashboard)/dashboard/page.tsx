"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, Bot, MessagesSquare, Receipt, TrendingUp, Users, Workflow, Sparkles } from "lucide-react";
import { formatNumber, t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";

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

function Section({ title, icon, link, children }: { title: string; icon: React.ReactNode; link?: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {icon}
          {title}
        </h2>
        {link && (
          <Link href={link} className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
            {t.common.details} ←
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">{children}</div>
    </Card>
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
      setError("تعذّر تحميل التحليلات، حاول مجددًا.");
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

  const conversion =
    data && data.messages.inbound > 0
      ? Math.round((data.orders.confirmed / data.conversations.total) * 1000) / 10
      : null;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-ink">{t.dashboard.greeting} 👋</h1>
          <p className="mt-0.5 text-xs text-ink-muted">نظرة سريعة على أداء متجرك خلال الفترة المحددة.</p>
        </div>
        <div className="flex gap-2">
          <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label="الفترة الزمنية">
            {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="المنطقة الزمنية">
            {["UTC", "Asia/Damascus", "Asia/Riyadh", "Asia/Dubai", "Africa/Cairo"].map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </Select>
        </div>
      </div>

      {error && (
        <EmptyState
          title="تعذّر تحميل البيانات"
          description={error}
          action={<Button size="sm" variant="secondary" onClick={load}>إعادة المحاولة</Button>}
        />
      )}

      {loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
          <Skeleton className="h-40" />
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {/* Top KPIs */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label={t.dashboard.conversations} value={formatNumber(data.conversations.total)} icon={<MessagesSquare size={18} />} />
            <StatCard label={t.dashboard.orders} value={formatNumber(data.orders.created)} icon={<Receipt size={18} />} />
            <StatCard label={t.dashboard.customers} value={formatNumber(data.conversations.total)} icon={<Users size={18} />} />
            <StatCard label={t.dashboard.conversion} value={conversion === null ? "—" : `${conversion}%`} tone="emerald" icon={<TrendingUp size={18} />} />
            <StatCard label={t.dashboard.aiMessages} value={formatNumber(data.ai.calls)} tone="violet" icon={<Sparkles size={18} />} />
            <StatCard label={t.dashboard.needsHuman} value={formatNumber(data.handoffs.open)} tone="amber" icon={<ArrowLeftRight size={18} />} />
          </div>

          <Section title="المبيعات" icon={<Receipt size={14} className="text-ink-subtle" />}>
            <StatCard label="طلبات مؤكدة" value={formatNumber(data.orders.confirmed)} tone="emerald" />
            <StatCard label="طلبات مُسلَّمة" value={formatNumber(data.orders.delivered)} tone="emerald" />
            <StatCard label="إيرادات مؤكدة" value={formatNumber(data.revenue.confirmed)} />
            <StatCard label="إيرادات مُسلَّمة" value={formatNumber(data.revenue.delivered)} />
          </Section>

          <Section title="المحادثات" icon={<MessagesSquare size={14} className="text-ink-subtle" />} link="/conversations">
            <StatCard label="محادثات جديدة" value={formatNumber(data.conversations.total)} />
            <StatCard label="نشطة" value={formatNumber(data.conversations.active)} tone="sky" />
            <StatCard label="رسائل واردة" value={formatNumber(data.messages.inbound)} />
            <StatCard label="رسائل صادرة" value={formatNumber(data.messages.outbound)} />
          </Section>

          <Section title="الذكاء الاصطناعي" icon={<Bot size={14} className="text-ink-subtle" />} link="/ai/playground">
            <StatCard label="استدعاءات AI" value={formatNumber(data.ai.calls)} tone="violet" />
            <StatCard label="استدعاءات فاشلة" value={formatNumber(data.ai.failed)} tone="red" />
            <StatCard label="Tokens" value={formatNumber(data.ai.tokens)} />
            <StatCard label="التكلفة التقديرية" value={formatNumber(data.ai.estimatedCost)} />
          </Section>

          <Section title="الدعم البشري" icon={<ArrowLeftRight size={14} className="text-ink-subtle" />} link="/handoffs">
            <StatCard label="تحويلات مفتوحة" value={formatNumber(data.handoffs.open)} tone="amber" />
            <StatCard label="إجمالي التحويلات" value={formatNumber(data.handoffs.total)} />
            <StatCard label="متوسط زمن الحل (دقيقة)" value={formatNumber(data.handoffs.avgResolutionMinutes)} />
          </Section>

          <Section title="الأتمتة" icon={<Workflow size={14} className="text-ink-subtle" />} link="/automation">
            <StatCard label="تنفيذات" value={formatNumber(data.automation.executions)} />
            <StatCard label="ناجحة" value={formatNumber(data.automation.completed)} tone="emerald" />
            <StatCard label="فاشلة" value={formatNumber(data.automation.failed)} tone="red" />
            <StatCard label="متجاوزة" value={formatNumber(data.automation.skipped)} />
          </Section>
        </div>
      )}
    </div>
  );
}