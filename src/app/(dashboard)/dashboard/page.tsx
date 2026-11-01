"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowLeftRight, Bot, Hand, MessagesSquare, Receipt, Sparkles, TrendingUp, Users, Workflow } from "lucide-react";
import { formatNumber, t } from "@/lib/i18n";
import { TIMEZONE_OPTIONS } from "@/lib/timezones";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SetupChecklist } from "@/components/setup-checklist";

type Overview = {
  conversations: { total: number; active: number; resolved: number };
  customers: { newInRange: number; total: number };
  messages: { inbound: number; outbound: number };
  orders: { created: number; confirmed: number; delivered: number; cancelled: number };
  revenue: { confirmed: number; delivered: number };
  ai: { calls: number; failed: number; tokens: number; estimatedCost: number | null };
  handoffs: { total: number; open: number; avgResolutionMinutes: number | null };
  automation: { executions: number; completed: number; failed: number; skipped: number };
};

const RANGES: [string, string][] = [
  ["today", "اليوم"], ["yesterday", "أمس"], ["last_7_days", "آخر 7 أيام"], ["last_30_days", "آخر 30 يومًا"],
];

function Section({ title, icon, link, children }: { title: string; icon: React.ReactNode; link?: string; children: React.ReactNode }) {
  return (
    <GlassCard>
      <div className="mb-1 flex items-center justify-between px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            {icon}
          </span>
          {title}
        </h2>
        {link && (
          <Link href={link} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 transition hover:gap-2 dark:text-brand-400">
            {t.common.details}
            <ArrowLeft size={13} />
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 px-4 pb-4 md:grid-cols-4">{children}</div>
    </GlassCard>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string | number; tone?: "brand" | "emerald" | "amber" | "sky" | "red" }) {
  const tones: Record<string, string> = {
    brand: "text-brand-600 dark:text-brand-300",
    emerald: "text-emerald-600 dark:text-emerald-300",
    amber: "text-amber-600 dark:text-amber-300",
    sky: "text-sky-600 dark:text-sky-300",
    red: "text-red-600 dark:text-red-300",
  };
  return (
    <div className="glass-subtle rounded-xl px-3.5 py-3 transition-colors">
      <p className="num text-lg font-bold leading-6 text-ink">{value}</p>
      <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-ink-muted">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${(tones[tone ?? "brand"])}`} aria-hidden />
        {label}
      </p>
    </div>
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
    data && data.messages.inbound > 0 && data.conversations.total > 0
      ? Math.round((data.orders.confirmed / Math.max(data.conversations.total, 1)) * 1000) / 10
      : null;

  return (
    <div className="page-wrap">
      {/* Hero */}
      <div data-hero className="glass relative overflow-hidden rounded-2xl px-5 py-5 sm:px-6">
        <div
          aria-hidden
          className="absolute inset-y-0 start-0 w-1 bg-primary"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="inline-flex items-center gap-1.5 rounded-[4px] bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300">
              <Sparkles size={12} />
              {t.app.tagline}
            </p>
            <h1 className="mt-2 text-xl font-semibold leading-8 text-ink">{t.dashboard.greeting}</h1>
            <p className="mt-1 text-[13px] text-ink-muted">{t.dashboard.welcomeBack}</p>
          </div>
          <div className="flex gap-2">
            <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label="الفترة الزمنية" className="w-auto">
              {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Select value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="المنطقة الزمنية" className="w-auto">
              {TIMEZONE_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {/* خطوات البداية: محسوبة من بيانات المساحة الفعلية، وبتختفي بصمت لمن ما إله صلاحية. */}
      <SetupChecklist />

      {error && (
        <GlassCard className="p-2">
          <EmptyState
            title="تعذّر تحميل البيانات"
            description={error}
            action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>}
          />
        </GlassCard>
      )}

      {loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {/* Top KPIs */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label={t.dashboard.conversations} value={formatNumber(data.conversations.total)} tone="brand" icon={<MessagesSquare size={18} />} />
            <StatCard label={t.dashboard.orders} value={formatNumber(data.orders.created)} tone="sky" icon={<Receipt size={18} />} />
            {/* P10 — عملاء جدد حقيقيون (كانت تستنسخ عدد المحادثات — placeholder) */}
            <StatCard label={`${t.dashboard.customers} (جدد)`} value={formatNumber(data.customers.newInRange)} tone="sky" icon={<Users size={18} />} />
            <StatCard label={t.dashboard.conversion} value={conversion === null ? "—" : `${conversion}%`} tone="emerald" icon={<TrendingUp size={18} />} />
            <StatCard label={t.dashboard.aiMessages} value={formatNumber(data.ai.calls)} tone="sky" icon={<Bot size={18} />} />
            <StatCard label={t.dashboard.needsHuman} value={formatNumber(data.handoffs.open)} tone="amber" icon={<Hand size={18} />} />
          </div>

          <Section title="المبيعات" icon={<Receipt size={15} />} link="/orders">
            <MiniStat label="طلبات مؤكدة" value={formatNumber(data.orders.confirmed)} tone="emerald" />
            <MiniStat label="طلبات مُسلَّمة" value={formatNumber(data.orders.delivered)} tone="emerald" />
            <MiniStat label="إيرادات مؤكدة" value={formatNumber(data.revenue.confirmed)} tone="brand" />
            <MiniStat label="إيرادات مُسلَّمة" value={formatNumber(data.revenue.delivered)} tone="sky" />
          </Section>

          <Section title="المحادثات" icon={<MessagesSquare size={15} />} link="/conversations">
            <MiniStat label="نشطة" value={formatNumber(data.conversations.active)} tone="sky" />
            <MiniStat label="رسائل واردة" value={formatNumber(data.messages.inbound)} tone="sky" />
            <MiniStat label="رسائل صادرة" value={formatNumber(data.messages.outbound)} tone="emerald" />
          </Section>

          {/* ⚠️ كانت «التفاصيل» هون بتودّي للتجربة، و٣ أرقام بتتكرر من البطاقات الي فوق.
              🔧 التفاصيل ← تبويب الوكيل بالتقارير، وكل رقم مرة وحدة. */}
          <Section title="الوكيل الذكي" icon={<Bot size={15} />} link="/analytics?tab=ai">
            <MiniStat label="استدعاءات فاشلة" value={formatNumber(data.ai.failed)} tone="red" />
            <MiniStat label="توكنز مستهلكة" value={formatNumber(data.ai.tokens)} tone="brand" />
            {/* null = لا تسعير معروف — تُعرض "غير متاح" لا صفر */}
            <MiniStat label="التكلفة التقديرية" value={data.ai.estimatedCost === null ? "غير متاح" : formatNumber(data.ai.estimatedCost)} tone="amber" />
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="الدعم البشري" icon={<ArrowLeftRight size={15} />} link="/handoffs">
              <MiniStat label="إجمالي التحويلات" value={formatNumber(data.handoffs.total)} tone="brand" />
              <MiniStat label="متوسط زمن الحل (دقيقة)" value={formatNumber(data.handoffs.avgResolutionMinutes)} tone="sky" />
            </Section>

            <Section title="الأتمتة" icon={<Workflow size={15} />} link="/automation">
              <MiniStat label="تنفيذات" value={formatNumber(data.automation.executions)} tone="brand" />
              <MiniStat label="ناجحة" value={formatNumber(data.automation.completed)} tone="emerald" />
              <MiniStat label="فاشلة" value={formatNumber(data.automation.failed)} tone="red" />
              <MiniStat label="متجاوزة" value={formatNumber(data.automation.skipped)} tone="amber" />
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
