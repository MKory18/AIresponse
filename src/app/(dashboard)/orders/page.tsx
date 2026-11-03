"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList, Printer, Search, Trash2 } from "lucide-react";
import { formatNumber, label, t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyNext, EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { SkeletonTable } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Order = {
  id: string;
  orderNumber: string;
  status: string;
  confirmationStatus: string;
  total: string;
  currency: string;
  createdAt: string;
  customer: { id: string; name: string | null; phone: string | null };
  items: { productNameSnapshot: string; quantity: number }[];
};

const STATUSES = ["NEW", "CONFIRMATION_PENDING", "CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "RETURNED"];

/**
 * مسودة طلب جاهزة: بياناتها اكتملت، وبُعتت (أو بتنتظر) لمجموعة تلجرام.
 * مش Order بعد — ما إلها رقم طلب ولا بتدخل المالية، وبتظهر هون عشان ما تضيع.
 */
type ReadyDraft = {
  id: string;
  conversationId: string;
  productName: string | null;
  quantity: number | null;
  items: { productName?: string | null; quantity?: number | null }[];
  updatedAt: string;
  customer: { name: string | null; phone: string | null } | null;
  telegramNotified: boolean;
};

function draftLabel(draft: ReadyDraft): string {
  const names = (draft.items ?? [])
    .map((i) => i.productName?.trim())
    .filter((n): n is string => Boolean(n));
  if (names.length > 0) return names.join("، ");
  return draft.productName ?? "—";
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [drafts, setDrafts] = useState<ReadyDraft[]>([]);
  const [status, setStatus] = useState("");
  const [confirmationStatus, setConfirmationStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // حذف الطلبات للمالك فقط — الخادم يقرر، والواجهة بتخفي الإجراء عن غيره.
  const [canDelete, setCanDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Order | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (confirmationStatus) params.set("confirmationStatus", confirmationStatus);
    const [res, draftRes] = await Promise.all([
      fetch(`/api/orders?${params}`),
      // المسودات الجاهزة تظهر دائمًا — ما بتتأثر بفلتر حالة الطلبات.
      fetch("/api/order-drafts?state=READY&limit=100"),
    ]);
    if (!res.ok) {
      setError("تعذّر تحميل الطلبات، حاول مجددًا.");
      return;
    }
    const data = await res.json();
    setOrders(data.items);
    setCanDelete(Boolean(data.canDelete));
    if (draftRes.ok) {
      const draftData = (await draftRes.json()) as { items: ReadyDraft[] };
      // اللي انحوّل لطلب ما بينعرض مرتين.
      setDrafts((draftData.items ?? []).filter((d) => (d as ReadyDraft & { orderId?: string | null }).orderId == null));
    } else {
      setDrafts([]);
    }
    setError(null);
  }, [status, confirmationStatus]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
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
    needsReview: orders.filter((o) => ["CANCELLED", "FAILED", "RETURNED"].includes(o.status)).length,
  };

  const visible = q.trim()
    ? orders.filter((o) =>
        [o.orderNumber, o.customer.name ?? "", o.customer.phone ?? "", o.items[0]?.productNameSnapshot ?? ""]
          .join(" ")
          .includes(q.trim())
      )
    : orders;

  const visibleDrafts = q.trim()
    ? drafts.filter((d) =>
        [d.customer?.name ?? "", d.customer?.phone ?? "", draftLabel(d)].join(" ").includes(q.trim())
      )
    : drafts;

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
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.orders.status} className="w-44">
          <option value="">{t.common.all} — الحالات</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </Select>
        <Select value={confirmationStatus} onChange={(e) => setConfirmationStatus(e.target.value)} aria-label="حالة التأكيد" className="w-48">
          <option value="">{t.common.all} — حالات التأكيد</option>
          {["PENDING", "CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT", "DECLINED"].map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </Select>
      </GlassCard>

      {/* طلبات جاهزة — مسودات مكتملة (قبل ما تصير Order) */}
      {!loading && visibleDrafts.length > 0 && (
        <GlassCard className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="text-sm font-bold text-ink">طلبات جاهزة (مسودات)</p>
            <p className="text-[11px] text-ink-subtle">
              بياناتها اكتملت — بتنرحّل لمجموعة تلجرام، وبتصير طلب رسمي بعد تأكيد الزبون.
            </p>
          </div>
          <div className="divide-y divide-line">
            {visibleDrafts.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                <span className="text-xs font-bold text-ink">{d.customer?.name ?? "—"}</span>
                {d.customer?.phone && <span className="num text-[11px] text-ink-muted" dir="ltr">{d.customer.phone}</span>}
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">{draftLabel(d)}</span>
                <span className="text-[10px] text-ink-subtle">{new Date(d.updatedAt).toLocaleDateString("ar")}</span>
                {d.telegramNotified ? (
                  <Badge tone="DELIVERED" dot>تم ترحيله للتلجرام</Badge>
                ) : (
                  <Badge tone="PENDING" dot>لم يُرحّل بعد</Badge>
                )}
                <Link href="/conversations" className="text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400">
                  افتح المحادثة
                </Link>
              </div>
            ))}
          </div>
        </GlassCard>
      )}

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
                    <td><StatusBadge value={o.status} dot /></td>
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
                  <StatusBadge value={o.status} dot />
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
