"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ClipboardList, Printer, Search, Trash2 } from "lucide-react";
import { formatNumber, t } from "@/lib/i18n";
import { ORDER_TABS, orderMatchesTab, orderStatusLabel, type OrderTab, type StatusTone } from "@/lib/order-status";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyNext, EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SkeletonTable } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { useRealtime } from "@/components/realtime/use-realtime";

type Order = {
  id: string;
  orderNumber: string;
  status: string;
  confirmationStatus: string;
  total: string;
  currency: string;
  createdAt: string;
  telegramNotified?: boolean;
  /** قارئ الطلب (1.4+): التثبيت والإيقاف وحالة الـ OMS — بتنعرض بعمود حالة واحد. */
  sealedAt?: string | null;
  heldBy?: string | null;
  omsStatus?: string | null;
  omsShippingStatus?: string | null;
  customer: { id: string; name: string | null; phone: string | null };
  items: { productNameSnapshot: string; quantity: number }[];
};

const TONE_CLASS: Record<StatusTone, string> = {
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warn: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  bad: "bg-red-500/10 text-red-700 dark:text-red-300",
  muted: "bg-surface-3 text-ink-muted",
};

/** عمود حالة واحد (بدل حالة + حالة التأكيد + تلجرام). */
function OrderStatusPill({ o }: { o: Order }) {
  const s = orderStatusLabel(o);
  return <span className={cn("inline-flex max-w-56 items-center rounded-lg px-2 py-0.5 text-[11px] font-bold", TONE_CLASS[s.tone])}>{s.text}</span>;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<OrderTab>("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // حذف الطلبات للمالك فقط — الخادم يقرر، والواجهة بتخفي الإجراء عن غيره.
  const [canDelete, setCanDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Order | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/orders");
    if (!res.ok) {
      setError("تعذّر تحميل الطلبات، حاول مجددًا.");
      return;
    }
    const data = await res.json();
    setOrders(data.items);
    setCanDelete(Boolean(data.canDelete));
    setError(null);
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  // لحظي: طلب جديد أو ترحيل تلجرام يظهر فورًا بلا تحديث. واحتياطي كل دقيقة.
  const lastLive = useRef(0);
  useRealtime((change) => {
    if (!change.type.startsWith("order")) return;
    const now = Date.now();
    if (now - lastLive.current < 4000) return;
    lastLive.current = now;
    void load();
  });
  useEffect(() => {
    const interval = setInterval(() => void load(), 60000);
    return () => clearInterval(interval);
  }, [load]);

  async function removeOrder(order: Order) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { message?: string }).message ?? "تعذّر حذف الطلب");
        return;
      }
      setDeleteTarget(null);
      setNotice(`تم حذف الطلب ${order.orderNumber}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const stats = {
    total: orders.length,
    new: orders.filter((o) => o.status === "NEW").length,
    confirming: orders.filter((o) => o.status === "CONFIRMATION_PENDING" || o.confirmationStatus === "PENDING").length,
    completed: orders.filter((o) => o.status === "DELIVERED").length,
    needsReview: orders.filter((o) => orderMatchesTab(o, "review")).length,
  };
  const tabCounts = Object.fromEntries(ORDER_TABS.map((x) => [x.key, orders.filter((o) => orderMatchesTab(o, x.key)).length])) as Record<OrderTab, number>;
  const byTab = orders.filter((o) => orderMatchesTab(o, tab));

  const visible = q.trim()
    ? byTab.filter((o) =>
        [o.orderNumber, o.customer.name ?? "", o.customer.phone ?? "", o.items[0]?.productNameSnapshot ?? ""]
          .join(" ")
          .includes(q.trim())
      )
    : byTab;

  return (
    <div className="page-wrap">
      <PageHeader
        title={t.orders.title}
        description="تابع حالات الطلبات وتأكيدها لحظة بلحظة."
        actions={
          <Button size="sm" variant="secondary" onClick={() => window.print()}>
            <Printer size={14} /> طباعة
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label={t.orders.statTotal} value={formatNumber(stats.total)} tone="brand" icon={<ClipboardList size={18} />} />
        <StatCard label={t.orders.statNew} value={formatNumber(stats.new)} tone="sky" />
        <StatCard label={t.orders.statConfirming} value={formatNumber(stats.confirming)} tone="amber" />
        <StatCard label={t.orders.statCompleted} value={formatNumber(stats.completed)} tone="emerald" />
        <StatCard label={t.orders.statNeedsReview} value={formatNumber(stats.needsReview)} tone="red" />
      </div>

      {/* Filters */}
      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-52 flex-1">
          <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t.common.search} برقم الطلب أو العميل…`} aria-label={t.common.search} className="ps-9" />
        </div>
      </GlassCard>

      {/* تبويبات: «تحتاج مراجعة» أول ما بيدوّر عليه الموظف */}
      <div role="tablist" aria-label="تصفية الطلبات" className="flex flex-wrap gap-1.5">
        {ORDER_TABS.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            onClick={() => setTab(x.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition",
              tab === x.key ? "bg-primary text-white" : "bg-surface-2 text-ink-muted hover:bg-surface-hover"
            )}
          >
            {x.label}
            <span className={cn("num rounded-md px-1.5 text-[10px]", tab === x.key ? "bg-white/20" : x.key === "review" && tabCounts.review > 0 ? "bg-amber-500/20 text-amber-800 dark:text-amber-300" : "bg-surface-3")}>{formatNumber(tabCounts[x.key])}</span>
          </button>
        ))}
      </div>

      {error && (
        <GlassCard className="p-2">
          <EmptyState title="تعذّر تحميل الطلبات" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}
      {notice && (
        <GlassCard level="glass-subtle" className="px-4 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </GlassCard>
      )}
      {loading && (
        <GlassCard className="p-4">
          <SkeletonTable rows={6} />
        </GlassCard>
      )}

      {/* Desktop table */}
      {!loading && visible.length > 0 && (
        <>
          <GlassCard className="hidden overflow-hidden md:block">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.orders.id}</th>
                  <th>{t.orders.customer}</th>
                  <th>{t.orders.phone}</th>
                  <th>{t.orders.product}</th>
                  <th>{t.orders.quantity}</th>
                  <th>{t.orders.total}</th>
                  <th>{t.orders.status}</th>
                  <th>{t.orders.date}</th>
                  {canDelete && <th aria-label="إجراءات" />}
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/orders/${o.id}`} className="num font-bold text-brand-600 hover:underline dark:text-brand-400">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="font-medium">{o.customer.name ?? "—"}</td>
                    <td className="num text-ink-muted">{o.customer.phone ?? "—"}</td>
                    <td className="max-w-44 truncate text-ink-muted">{o.items[0]?.productNameSnapshot ?? "—"}</td>
                    <td className="num text-ink-muted">{o.items[0]?.quantity ?? "—"}</td>
                    <td className="num font-bold" dir="ltr">
                      {Number(o.total).toLocaleString()} {o.currency}
                    </td>
                    <td><OrderStatusPill o={o} /></td>
                    <td className="whitespace-nowrap text-xs text-ink-muted">{new Date(o.createdAt).toLocaleDateString("ar")}</td>
                    {canDelete && (
                      <td>
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleteTarget(o)} title="حذف الطلب (المالك فقط)">
                          <Trash2 size={13} />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>

          {/* Mobile cards */}
          <div className="grid gap-3 md:hidden">
            {visible.map((o) => (
              <GlassCard key={o.id} className="p-4 transition-all active:scale-[0.99]">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/orders/${o.id}`} className="num text-sm font-bold text-brand-600 dark:text-brand-400">
                    {o.orderNumber}
                  </Link>
                  <OrderStatusPill o={o} />
                </div>
                <div className="mt-2.5 grid grid-cols-2 gap-1.5 text-xs text-ink-muted">
                  <span className="truncate font-medium text-ink">{o.customer.name ?? o.customer.phone ?? "—"}</span>
                  <span className="num text-end font-bold text-ink">{Number(o.total).toLocaleString()} {o.currency}</span>
                  <span className="col-span-2 truncate">{o.items[0]?.productNameSnapshot ?? "—"}</span>
                </div>
                {canDelete && (
                  <div className="mt-2.5 flex justify-end">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleteTarget(o)}>
                      <Trash2 size={13} /> حذف
                    </Button>
                  </div>
                )}
              </GlassCard>
            ))}
          </div>
        </>
      )}

      {!loading && visible.length === 0 && !error && (
        <GlassCard>
          <EmptyState
            illustration="/brand/empty-orders.webp"
            title={t.orders.emptyTitle}
            description={t.orders.emptyDesc}
            action={<EmptyNext href="/conversations">افتح الوارد</EmptyNext>}
          />
        </GlassCard>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void removeOrder(deleteTarget)}
        title={`حذف الطلب ${deleteTarget?.orderNumber ?? ""} نهائيًا؟`}
        body="ينحذف الطلب مع كل بنوده من النظام، وما بيرجع. سجل التدقيق بيحفظ العملية (الرقم · المجموع · الحالة) — الإجراء متاح للمالك فقط."
        confirmLabel="حذف نهائي"
        busy={busy}
        danger
      />
    </div>
  );
}
