"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bot, Download, Gauge, Megaphone, MessagesSquare, Package, RefreshCw, Receipt, TrendingUp, Trophy, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyNext, EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@/lib/i18n";
import { TIMEZONE_OPTIONS } from "@/lib/timezones";

/**
 * P10 — مركز التحليلات الموحد: تبويبات فوق طبقة API القائمة (نفس الخادم،
 * نفس الصلاحيات). القواعد المثبتة:
 * - null = "غير متاح" (غياب بيانات) — لا يُعرض صفر أبدًا.
 * - كل مؤشر يعرض تعريفه (title) ومصدره عند الاشتباه.
 * - المقارنة بين فترتين: نفس النافذة مزاحة للخلف — لا مقارنة إذا اختلفت
 *   مدة الفترتين (لا نمو وهمي).
 * - التصدير CSV عبر /api/analytics/export (نفس الفلاتر — أرقام متطابقة).
 *
 * ⚠️ كانت التقارير ٣ صفحات: هاي + «تحليلات الذكاء» + «تحليلات المنتجات» —
 * والتانيات نفس تبويبات هون بفترة ثابتة (٣٠ يوم) وبلا تصدير.
 * 🔧 صفحة وحدة: تبويب «المنتجات» (الجدول القابل للترتيب) انضاف هون، والروابط
 * القديمة بتحوّل لـ`?tab=ai` و`?tab=products`. التبويب بيضل بالرابط (تحديث = نفس المكان).
 */

type Json = Record<string, unknown>;

function jget(v: unknown, ...keys: string[]): Json | undefined {
  let cur: unknown = v;
  for (const k of keys) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return (cur ?? undefined) as Json | undefined;
}

const RANGES: [string, string][] = [
  ["today", "اليوم"], ["yesterday", "أمس"], ["last_7_days", "آخر 7 أيام"], ["last_30_days", "آخر 30 يومًا"],
];

const TABS: [string, string, React.ReactNode][] = [
  ["exec", "نظرة عامة", <Gauge key="a" size={15} />],
  ["conversations", "المحادثات", <MessagesSquare key="b" size={15} />],
  ["sales", "المبيعات", <Receipt key="c" size={15} />],
  ["products", "المنتجات", <Package key="p" size={15} />],
  ["agents", "الموظفون", <Users key="d" size={15} />],
  ["ai", "الذكاء", <Bot key="e" size={15} />],
  ["campaigns", "الحملات", <Megaphone key="f" size={15} />],
  ["automation", "الأتمتة", <Workflow key="g" size={15} />],
  ["trends", "الاتجاهات", <TrendingUp key="h" size={15} />],
];

function Cell({ value, suffix }: { value: unknown; suffix?: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-ink-muted">غير متاح</span>;
  return <span className="num">{formatNumber(value as number)}{suffix ?? ""}</span>;
}

function KV({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="glass-subtle flex items-center justify-between rounded-xl px-3.5 py-2.5">
      <span className="text-xs text-ink-muted">{k}</span>
      <span className="text-sm font-bold text-ink"><Cell value={v} /></span>
    </div>
  );
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 truncate text-xs text-ink-muted">{label}</span>
      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-brand-500/10">
        <span className="block h-full rounded-full bg-brand-500/60" style={{ width: `${pct}%` }} />
      </span>
      <span className="num w-12 shrink-0 text-end text-xs font-bold text-ink">{formatNumber(value)}</span>
    </div>
  );
}

function Buckets({ title, entries }: { title: string; entries: Array<{ key: string; count: number }> | Record<string, unknown> | undefined }) {
  const rows = useMemo(() => {
    if (!entries) return [];
    if (Array.isArray(entries)) return entries as Array<{ key: string; count: number }>;
    return Object.entries(entries as Record<string, unknown>).map(([key, count]) => ({ key, count: Number(count) }));
  }, [entries]);
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="space-y-2">
      <p className="text-xs font-bold text-ink">{title}</p>
      {rows.map((r) => <Bar key={r.key} label={r.key} value={r.count} max={max} />)}
    </div>
  );
}

type ProductRow = {
  productId: string;
  productName: string;
  units: number;
  confirmedOrders: number;
  deliveredOrders: number;
  confirmedRevenue: number;
  deliveredRevenue: number;
};
type ProductSort = "units" | "confirmedRevenue" | "confirmedOrders";

/** أداء كل منتج — كانت صفحة «تحليلات المنتجات» لحالها. الأسعار من لقطة الطلب وقت البيع. */
function ProductsTable({ rows }: { rows: ProductRow[] }) {
  const [sort, setSort] = useState<ProductSort>("units");
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Package size={28} strokeWidth={1.5} />}
        title="لا بيانات منتجات بهالفترة"
        description="أداء كل منتج بيظهر هون بعد أول طلب مؤكد."
        action={<EmptyNext href="/orders">شوف الطلبات</EmptyNext>}
      />
    );
  }
  const sorted = [...rows].sort((a, b) => b[sort] - a[sort]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">الأسعار من الطلب وقت البيع، مش سعر المنتج الحالي.</p>
        <Select value={sort} onChange={(e) => setSort(e.target.value as ProductSort)} aria-label="ترتيب" className="w-56">
          <option value="units">ترتيب حسب: الكميات</option>
          <option value="confirmedRevenue">ترتيب حسب: الإيرادات المؤكدة</option>
          <option value="confirmedOrders">ترتيب حسب: الطلبات المؤكدة</option>
        </Select>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>المنتج</th>
              <th>الكميات</th>
              <th>طلبات مؤكدة</th>
              <th>إيرادات مؤكدة</th>
              <th>طلبات مُسلّمة</th>
              <th>إيرادات مُسلّمة</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.productId}>
                <td>
                  <Link href={`/products/${r.productId}`} className="flex items-center gap-2 font-bold hover:text-primary">
                    {i === 0 && <Trophy size={14} className="shrink-0 text-amber-500" />}
                    {r.productName}
                  </Link>
                </td>
                <td className="num font-bold">{formatNumber(r.units)}</td>
                <td className="num">{formatNumber(r.confirmedOrders)}</td>
                <td className="num">{formatNumber(r.confirmedRevenue)}</td>
                <td className="num">{formatNumber(r.deliveredOrders)}</td>
                <td className="num">{formatNumber(r.deliveredRevenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TAB_IDS = new Set(TABS.map(([id]) => id));

/** مقارنة فترتين: نافذة مخصصة بنفس الطول مزاحة للخلف (لا مقارنة بطول مختلف). */
function prevRangeParams(range: string, timezone: string): Record<string, string> | null {
  if (range === "today" || range === "yesterday") return { range: "yesterday", timezone };
  const days = range === "last_7_days" ? 7 : range === "last_30_days" ? 30 : null;
  if (!days) return null; // مخصص — لا مقارنة تلقائية
  const to = new Date(Date.now() - days * 24 * 3600_000);
  const from = new Date(to.getTime() - days * 24 * 3600_000);
  return { range: "custom", from: from.toISOString(), to: to.toISOString(), timezone };
}

/**
 * نوع ملف التصدير لكل تبويب. ⚠️ كان «الأتمتة» بيصدّر محادثات و«الاتجاهات» طلبات —
 * ملف غير الي على الشاشة. 🔧 التبويب الي ما إله تصدير مطابق ما بيظهر فيه الزر.
 */
const EXPORT_TYPE: Record<string, string> = {
  exec: "sales", conversations: "conversations", sales: "orders", products: "products",
  agents: "agents", ai: "ai", campaigns: "campaigns",
};

export default function AnalyticsPage() {
  const [tab, setTabState] = useState("exec");
  // التبويب من الرابط (`?tab=ai`) قبل أول تحميل — الروابط القديمة بتحوّل لهون.
  const [tabReady, setTabReady] = useState(false);
  const [range, setRange] = useState("last_7_days");
  const [timezone, setTimezone] = useState("UTC");
  const [compare, setCompare] = useState(false);
  const [data, setData] = useState<Record<string, Json | null> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  const endpoints: Record<string, string[]> = useMemo(() => ({
    exec: ["overview", "funnel", "sales"],
    conversations: ["conversations", "handoffs"],
    sales: ["orders", "sales"],
    products: ["products"],
    agents: ["agents"],
    ai: ["ai"],
    campaigns: ["campaigns"],
    automation: ["automations", "follow-ups"],
    trends: ["trends"],
  }), []);

  useEffect(() => {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get("tab");
      if (fromUrl && TAB_IDS.has(fromUrl)) setTabState(fromUrl);
    } catch { /* ignore */ }
    setTabReady(true);
  }, []);

  function setTab(id: string) {
    setTabState(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", id);
      window.history.replaceState(null, "", url.toString());
    } catch { /* ignore */ }
  }

  const load = useCallback(async () => {
    if (!tabReady) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ range, timezone });
      const results: Record<string, Json | null> = {};
      const list = endpoints[tab] ?? [];
      await Promise.all(list.map(async (name) => {
        const res = await fetch(`/api/analytics/${name}?${params}`);
        if (res.status === 403) { results[name] = null; return; }
        if (!res.ok) throw new Error(String(res.status));
        results[name] = await res.json();
      }));
      // مقارنة الفترة السابقة (للنظرة العامة فقط — نفس الطول)
      const prev = compare ? prevRangeParams(range, timezone) : null;
      if (prev) {
        const res = await fetch(`/api/analytics/overview?${new URLSearchParams(prev)}`);
        if (res.ok) results.overviewPrev = await res.json();
      }
      setData(results);
    } catch {
      setError("تعذّر تحميل التحليلات، حاول مجددًا.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tab, tabReady, range, timezone, compare, endpoints]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    const exportType = EXPORT_TYPE;
    setExporting(true);
    try {
      const params = new URLSearchParams({ type: exportType[tab] ?? "orders", range, timezone });
      const res = await fetch(`/api/analytics/export?${params}`);
      if (!res.ok) {
        toast.show("تعذّر إنشاء ملف التصدير", "error");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `analytics-${exportType[tab]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.show("تعذّر إنشاء ملف التصدير", "error");
    } finally {
      setExporting(false);
    }
  };

  const o = data?.overview as Record<string, Json> | null | undefined;
  const op = data?.overviewPrev as Record<string, Json> | null | undefined;
  const pct = (cur: unknown, prev: unknown): { text: string; up: boolean | null } => {
    if (typeof cur !== "number" || typeof prev !== "number") return { text: "—", up: null };
    if (prev === 0) return { text: cur > 0 ? "جديد" : "—", up: null };
    const diff = Math.round(((cur - prev) / prev) * 1000) / 10;
    return { text: `${diff > 0 ? "+" : ""}${diff}%`, up: diff >= 0 };
  };

  return (
    <div className="page-wrap">
      <PageHeader title="التقارير" description="أرقامك الفعلية حسب الفترة — والي ما انسجّل بيبيّن «غير متاح» مش صفر." />

      {/* الفلاتر */}
      <GlassCard className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label="الفترة" className="w-auto">
          {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="المنطقة الزمنية" className="w-auto">
          {TIMEZONE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        {tab === "exec" && (
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
            مقارنة مع الفترة السابقة
          </label>
        )}
        <span className="grow" />
        <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> تحديث
        </Button>
        {EXPORT_TYPE[tab] && (
          <Button size="sm" onClick={exportCsv} disabled={exporting || loading}>
            <Download size={14} /> تصدير Excel (CSV)
          </Button>
        )}
      </GlassCard>

      {/* التبويبات */}
      <div role="tablist" aria-label="أقسام التحليلات" className="flex flex-wrap gap-2">
        {TABS.map(([id, label, icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
              tab === id ? "bg-brand-500/15 text-brand-700 dark:text-brand-300" : "glass-subtle text-ink-muted hover:text-ink"
            }`}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {error && (
        <GlassCard className="p-2">
          <EmptyState title="تعذّر تحميل البيانات" description={error} action={<Button size="sm" variant="secondary" onClick={load}>إعادة المحاولة</Button>} />
        </GlassCard>
      )}

      {loading && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>}

      {!loading && !error && (
        <>
          {/* نظرة عامة + مقارنة فترتين */}
          {tab === "exec" && o && (
            <GlassCard className="space-y-3 p-4">
              <p className="text-sm font-bold text-ink">مؤشرات تنفيذية {compare && op && <span className="text-xs font-normal text-ink-muted">— مع تغير الفترة السابقة</span>}</p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {([
                  { k: "conversations", label: "محادثات جديدة", sec: o.conversations, f: "total" },
                  { k: "customers", label: "عملاء جدد", sec: o.customers, f: "newInRange" },
                  { k: "orders", label: "طلبات مؤكدة", sec: o.orders, f: "confirmed" },
                  { k: "revenue", label: "قيمة مؤكدة", sec: o.revenue, f: "confirmed" },
                  { k: "messages", label: "رسائل واردة", sec: o.messages, f: "inbound" },
                  { k: "ai", label: "ردود الذكاء", sec: o.ai, f: "calls" },
                  { k: "handoffs", label: "تحويلات للموظف", sec: o.handoffs, f: "total" },
                  { k: "automation", label: "تنفيذات أتمتة", sec: o.automation, f: "executions" },
                ] as const).map(({ k, label, sec, f }) => {
                  const cur = (sec as Json | null | undefined)?.[f];
                  const prevV = compare && op ? (op[k] as Json | undefined)?.[f] : undefined;
                  const d = compare && op ? pct(cur, prevV) : { text: "", up: null };
                  return (
                    <div key={k} className="glass-subtle rounded-xl px-3.5 py-3">
                      <p className="num text-lg font-bold text-ink"><Cell value={cur} /></p>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
                        {label}
                        {compare && op && d.up !== null && (
                          <span className={`font-bold ${d.up ? "text-emerald-600 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}`}>({d.text})</span>
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
              {/* قيمة القسم: لا تكلفة معروفة ≠ صفر */}
              {o.ai && o.ai.estimatedCost === null && (
                <p className="text-xs text-ink-muted">تكلفة الذكاء: غير متاحة لهالفترة (ما في سعر معروف للنموذج).</p>
              )}
              {data?.funnel && (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                  {[
                    ["محادثات", (data.funnel as Json).conversations],
                    ["مسودات طلب", (data.funnel as Json).draftsStarted],
                    ["مسودات جاهزة", (data.funnel as Json).draftsReady],
                    ["طلبات مؤكدة", (data.funnel as Json).ordersConfirmed],
                    ["طلبات مسلَّمة", (data.funnel as Json).ordersDelivered],
                  ].map(([k, v]) => <KV key={String(k)} k={String(k)} v={v} />)}
                </div>
              )}
              <p className="text-xs text-ink-muted">
                المسودة مش بيع: البيع بينحسب لما يتأكد الطلب، والمسلَّم لما يستلمه الزبون فعلًا.
              </p>
            </GlassCard>
          )}

          {/* المحادثات */}
          {tab === "conversations" && (
            <GlassCard className="space-y-3 p-4">
              {data?.conversations ? (
                <>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    <KV k="محادثات جديدة" v={(data.conversations as Json).newConversations} />
                    <KV k="رسائل واردة (ليست محادثات)" v={(data.conversations as Json).inboundMessages} />
                    <KV k="رسائل صادرة" v={(data.conversations as Json).outboundMessages} />
                    <KV k="أول رد — متوسط (د)" v={jget(data.conversations, "firstResponse", "avgMinutes")} />
                    <KV k="أول رد — وسيط (د)" v={jget(data.conversations, "firstResponse", "medianMinutes")} />
                    <KV k="زمن الحل — وسيط (د)" v={jget(data.conversations, "resolution", "medianMinutes")} />
                  </div>
                  <p className="text-xs text-ink-muted">
                    التعريف: زمن أول رد = أول رسالة صادرة بعد أول رسالة عميل — المحادثة تُحسب مرة واحدة مهما تعددت رسائلها.
                  </p>
                </>
              ) : null}
              {data?.handoffs && (
                <Buckets title="التحويلات للموظف حسب السبب" entries={(data.handoffs as Json).byReason as Json} />
              )}
            </GlassCard>
          )}

          {/* المبيعات */}
          {tab === "sales" && (
            <GlassCard className="space-y-3 p-4">
              {data?.orders ? (
                <>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    <KV k="طلبات منشأة (ليست مبيعات مؤكدة)" v={(data.orders as Json).created} />
                    <KV k="طلبات مؤكدة" v={(data.orders as Json).confirmed} />
                    <KV k="مسلَّمة" v={(data.orders as Json).delivered} />
                    <KV k="ملغاة" v={(data.orders as Json).cancelled} />
                    <KV k="قيمة مؤكدة" v={jget(data.orders, "gmv", "confirmedGmv")} />
                    <KV k="متوسط قيمة الطلب المؤكد" v={Number(jget(data.orders, "confirmed") ?? 0) > 0 ? Number(jget(data.orders, "gmv", "confirmedGmv") ?? 0) / Number(jget(data.orders, "confirmed")) : null} />
                  </div>
                  <p className="text-xs text-ink-muted">
                    المسودة مش بيع · المؤكد مش مُسلَّم · والمُسلَّم مش محصَّل — كل رقم لحاله.
                  </p>
                </>
              ) : null}
              {data?.sales && (
                <>
                  <Buckets title="العروض والمنتجات المكمّلة" entries={{
                    "عروض مؤهلة": (data.sales as Json).offersQualified,
                    "عروض ظهرت": (data.sales as Json).offersShown,
                    "مكمل ظهر": (data.sales as Json).crossSellShown,
                    "مكمل أُضيف": (data.sales as Json).crossSellAdded,
                  } as Json} />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <KV
                      k="نسبة قبول العروض (من الي ظهرت)"
                      v={
                        jget(data.sales, "offerAcceptRate") === undefined ||
                        jget(data.sales, "offerAcceptRate") === null
                          ? null
                          : `${Math.round(Number(jget(data.sales, "offerAcceptRate")) * 1000) / 10}%`
                      }
                    />
                    {jget(data.sales, "offerAcceptRate") === null && (
                      <p className="self-center text-[11px] text-ink-muted">ما ظهر ولا عرض بهالفترة.</p>
                    )}
                  </div>
                </>
              )}
              <button type="button" onClick={() => setTab("products")} className="text-xs font-bold text-primary hover:underline">
                أداء كل منتج ←
              </button>
            </GlassCard>
          )}

          {/* المنتجات */}
          {tab === "products" && (
            <GlassCard className="p-4">
              <ProductsTable rows={Array.isArray(data?.products) ? (data!.products as unknown as ProductRow[]) : []} />
            </GlassCard>
          )}

          {/* الموظفون */}
          {tab === "agents" && (
            <GlassCard className="space-y-3 p-4">
              {data?.agents === null ? (
                <EmptyState title="مش متاحة لدورك" description="أداء الموظفين بيشوفه المدير والمالك بس." />
              ) : data?.agents ? (
                <>
                  <div className="space-y-2">
                    {((data.agents as Json).agents as unknown as Array<Json>).map((a) => (
                      <div key={String(a.agentId)} className="glass-subtle grid grid-cols-2 gap-2 rounded-xl px-3.5 py-3 md:grid-cols-4">
                        <KV k="محادثات معينة" v={a.conversationsAssigned} />
                        <KV k="ردود صادرة" v={a.repliesSent} />
                        <KV k="أول رد — وسيط (د)" v={a.firstResponseMedianMinutes} />
                        <KV k="طلبات مرتبطة" v={a.ordersLinked} />
                        <KV k="طلبات مؤكدة مرتبطة" v={a.ordersLinkedConfirmed} />
                        <KV k="قيمتها" v={a.ordersLinkedConfirmedValue} />
                        <KV k="تحويلات موظف" v={a.handoffsClaimed} />
                        <KV k="خصومات معتمدة" v={a.discountApproved} />
                      </div>
                    ))}
                    {((data.agents as Json).agents as unknown as Array<Json>).length === 0 && (
                      <EmptyState title="لا بيانات" description="لا إسنادات موظفين في هذه الفترة." />
                    )}
                  </div>
                  <p className="text-xs text-ink-muted">{String(jget(data.agents, "attribution", "notes") ?? "")}</p>
                  <p className="text-xs text-ink-muted">العروض لكل موظف: غير متاحة — النظام ما بيسجّل مين عرضها (وما منخمّن).</p>
                </>
              ) : null}
            </GlassCard>
          )}

          {/* الذكاء */}
          {tab === "ai" && data?.ai && (
            <GlassCard className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <KV k="استدعاءات" v={(data.ai as Json).calls} />
                <KV k="ناجحة" v={(data.ai as Json).successful} />
                <KV k="فاشلة" v={(data.ai as Json).failed} />
                <KV k="متوسط سرعة الرد (ملّي ثانية)" v={(data.ai as Json).avgLatencyMs} />
                <KV k="توكنز داخلة" v={(data.ai as Json).inputTokens} />
                <KV k="توكنز طالعة" v={(data.ai as Json).outputTokens} />
                <div className="glass-subtle flex items-center justify-between rounded-xl px-3.5 py-2.5">
                  <span className="text-xs text-ink-muted">التكلفة (معروفة فقط)</span>
                  <span className="text-sm font-bold text-ink"><Cell value={(data.ai as Json).estimatedCost} /></span>
                </div>
              </div>
              <Buckets title="حسب المهمة" entries={(data.ai as Json).byTask as Json} />
              <Buckets title="حسب النموذج" entries={(data.ai as Json).byModel as Json} />
              <p className="text-xs text-ink-muted">التكلفة بتنحسب بس للنماذج الي سعرها معروف — الباقي «غير متاح» مش صفر.</p>
            </GlassCard>
          )}

          {/* الحملات */}
          {tab === "campaigns" && data?.campaigns && (
            <GlassCard className="space-y-3 p-4">
              <Buckets title="حالة الحملات (الكل)" entries={jget(data.campaigns, "campaigns", "statusDistribution")} />
              <Buckets title="المستلمون حسب الحالة" entries={jget(data.campaigns, "audience", "byStatus")} />
              <Buckets title="أسباب الاستبعاد" entries={jget(data.campaigns, "audience", "byExcludeReason")} />
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                <KV k="مستلمون (بدون تكرار)" v={jget(data.campaigns, "audience", "uniqueRecipients")} />
                <KV k="انبعتت للمنصّة" v={jget(data.campaigns, "sending", "apiAccepted")} />
                <KV k="تسليم مؤكد من المزود" v={jget(data.campaigns, "sending", "deliveryConfirmed")} />
              </div>
              <p className="text-xs text-ink-muted">
                «انبعتت» مش يعني «وصلت» ولا «انقرت» — تأكيد الوصول من المنصّة لسا مش مربوط.
                الطلبات الجاية من الحملة والعائد على الإعلان: غير متاحين (ما في ربط موثوق بتكلفة الإعلان).
              </p>
            </GlassCard>
          )}

          {/* الأتمتة */}
          {tab === "automation" && (
            <GlassCard className="space-y-3 p-4">
              {data?.automations && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-ink">تنفيذ القواعد (الي خلص فعلًا، مش الي انجدول بس)</p>
                  {((data.automations as unknown as Array<Json>) ?? []).map((a) => (
                    <div key={String(a.automationId)} className="glass-subtle grid grid-cols-2 gap-2 rounded-xl px-3.5 py-2.5 md:grid-cols-5">
                      <span className="col-span-2 truncate text-xs font-bold text-ink">{String(a.name)}</span>
                      <KV k="مكتملة" v={a.completed} />
                      <KV k="فاشلة" v={a.failed} />
                      <KV k="نسبة النجاح" v={a.successRate === null ? null : `${Math.round((a.successRate as number) * 1000) / 10}%`} />
                    </div>
                  ))}
                  {Array.isArray(data.automations) && (data.automations as unknown as Array<Json>).length === 0 && (
                    <EmptyState title="لا بيانات" description="لا تنفيذات في هذه الفترة." />
                  )}
                </div>
              )}
              {data?.["follow-ups"] && (
                <Buckets title="المتابعات حسب النوع" entries={(data["follow-ups"] as Json).byType as Json} />
              )}
            </GlassCard>
          )}

          {/* الاتجاهات */}
          {tab === "trends" && data?.trends && (
            <GlassCard className="space-y-3 p-4">
              {(() => {
                const t = data.trends as Json;
                const series = (t.series as unknown as Array<Json>) ?? [];
                const ok = series.filter((r) => r.dataStatus === "OK");
                if (!ok.length) {
                  return (
                    <EmptyState
                      title="بيانات الاتجاهات غير مبنية بعد"
                      description={`في ${String(jget(t.coverage, "missing") ?? "?")} يوم لسا ما انحسبوا — النظام بيحسبهم لحاله بالخلفية، ارجع بعد شوي.`}
                    />
                  );
                }
                const max = Math.max(...ok.map((r) => Number(r.conversations ?? 0)), 1);
                return (
                  <>
                    <Buckets title="محادثات كل يوم" entries={Object.fromEntries(ok.map((r) => [String(r.date).slice(5), Number(r.conversations ?? 0)]))} />
                    <p className="text-xs text-ink-muted">
                      آخر بناء: {String(jget(t.coverage, "lastRebuiltAt") ?? "—")} · أيام مفقودة: {String(jget(t.coverage, "missing") ?? 0)}
                      {jget(t.coverage, "rebuildEnqueued") ? " — قيد الحساب" : ""}
                    </p>
                    <p className="text-xs text-ink-muted">اليوم الي لسا ما انحسب ما بيظهر صفر. الأرقام بتتحدّث كل ٦ ساعات بالأكتر.</p>
                  </>
                );
              })()}
            </GlassCard>
          )}
        </>
      )}

    </div>
  );
}
