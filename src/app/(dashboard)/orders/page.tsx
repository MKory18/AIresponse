"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList, PackageSearch, Printer } from "lucide-react";
import { formatNumber, label, t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";

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

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState("");
  const [confirmationStatus, setConfirmationStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (confirmationStatus) params.set("confirmationStatus", confirmationStatus);
    const res = await fetch(`/api/orders?${params}`);
    if (!res.ok) {
      setError("تعذّر تحميل الطلبات، حاول مجددًا.");
      return;
    }
    setOrders((await res.json()).items);
    setError(null);
  }, [status, confirmationStatus]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const stats = {
    total: orders.length,
    new: orders.filter((o) => o.status === "NEW").length,
    confirming: orders.filter((o) => o.status === "CONFIRMATION_PENDING" || o.confirmationStatus === "PENDING").length,
    completed: orders.filter((o) => o.status === "DELIVERED").length,
    needsReview: orders.filter((o) => ["CANCELLED", "FAILED", "RETURNED"].includes(o.status)).length,
  };

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-ink">{t.orders.title}</h1>
          <p className="mt-0.5 text-xs text-ink-muted">متابعة ومتابعة حالات الطلبات وتأكيدها.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => window.print()}>
          <Printer size={12} /> {t.common.export}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label={t.orders.statTotal} value={formatNumber(stats.total)} icon={<ClipboardList size={18} />} />
        <StatCard label={t.orders.statNew} value={formatNumber(stats.new)} tone="sky" />
        <StatCard label={t.orders.statConfirming} value={formatNumber(stats.confirming)} tone="amber" />
        <StatCard label={t.orders.statCompleted} value={formatNumber(stats.completed)} tone="emerald" />
        <StatCard label={t.orders.statNeedsReview} value={formatNumber(stats.needsReview)} tone="red" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.orders.status} className="w-48">
          <option value="">{t.common.all} — الحالات</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </Select>
        <Select value={confirmationStatus} onChange={(e) => setConfirmationStatus(e.target.value)} aria-label="حالة التأكيد" className="w-52">
          <option value="">{t.common.all} — حالات التأكيد</option>
          {["PENDING", "CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT", "DECLINED"].map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </Select>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">{error}</p>}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-3" />
          ))}
        </div>
      )}

      {/* Desktop table */}
      {!loading && orders.length > 0 && (
        <>
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-line text-xs text-ink-muted">
                <tr className="bg-surface-1">
                  <th className="p-3 font-medium">{t.orders.id}</th>
                  <th className="p-3 font-medium">{t.orders.customer}</th>
                  <th className="p-3 font-medium">{t.orders.phone}</th>
                  <th className="p-3 font-medium">{t.orders.product}</th>
                  <th className="p-3 font-medium">{t.orders.quantity}</th>
                  <th className="p-3 font-medium">{t.orders.total}</th>
                  <th className="p-3 font-medium">{t.orders.status}</th>
                  <th className="p-3 font-medium">{t.orders.date}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-line/50 transition-colors last:border-0 hover:bg-surface-1">
                    <td className="p-3">
                      <Link href={`/orders/${o.id}`} className="num font-medium text-brand-600 hover:underline dark:text-brand-400">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="p-3 text-ink">{o.customer.name ?? "—"}</td>
                    <td className="num p-3 text-ink-muted">{o.customer.phone ?? "—"}</td>
                    <td className="p-3 text-ink-muted">{o.items[0]?.productNameSnapshot ?? "—"}</td>
                    <td className="num p-3 text-ink-muted">{o.items[0]?.quantity ?? "—"}</td>
                    <td className="num p-3 font-medium text-ink" dir="ltr">
                      {Number(o.total).toLocaleString()} {o.currency}
                    </td>
                    <td className="p-3"><StatusBadge value={o.status} /></td>
                    <td className="p-3 text-xs text-ink-muted">{new Date(o.createdAt).toLocaleDateString("ar")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {orders.map((o) => (
              <Card key={o.id} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/orders/${o.id}`} className="num text-sm font-bold text-brand-600 dark:text-brand-400">
                    {o.orderNumber}
                  </Link>
                  <StatusBadge value={o.status} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs text-ink-muted">
                  <span className="truncate">{o.customer.name ?? o.customer.phone ?? "—"}</span>
                  <span className="num text-end font-medium text-ink">{Number(o.total).toLocaleString()} {o.currency}</span>
                  <span className="col-span-2 truncate">{o.items[0]?.productNameSnapshot ?? "—"}</span>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {!loading && orders.length === 0 && !error && (
        <Card>
          <EmptyState
            icon={<PackageSearch size={28} strokeWidth={1.5} />}
            title={t.orders.emptyTitle}
            description={t.orders.emptyDesc}
          />
        </Card>
      )}
    </div>
  );
}