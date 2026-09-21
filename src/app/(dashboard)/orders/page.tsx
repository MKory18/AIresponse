"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

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

const STATUS_STYLES: Record<string, string> = {
  NEW: "bg-slate-100 text-slate-600",
  CONFIRMATION_PENDING: "bg-amber-50 text-amber-700",
  CONFIRMED: "bg-emerald-50 text-emerald-700",
  PROCESSING: "bg-blue-50 text-blue-700",
  OUT_FOR_DELIVERY: "bg-violet-50 text-violet-700",
  DELIVERED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-red-50 text-red-600",
  FAILED: "bg-red-50 text-red-600",
  RETURNED: "bg-slate-100 text-slate-500",
};

const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";
const STATUSES = Object.keys(STATUS_STYLES);

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
      setError("فشل تحميل الطلبات");
      return;
    }
    setOrders((await res.json()).items);
    setError(null);
  }, [status, confirmationStatus]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">الطلبات</h1>

      <div className="flex flex-wrap gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
          <option value="">كل الحالات</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={confirmationStatus} onChange={(e) => setConfirmationStatus(e.target.value)} className={input}>
          <option value="">كل حالات التأكيد</option>
          {["PENDING", "CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT", "DECLINED"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-right text-sm">
          <thead className="border-b border-slate-100 text-xs text-slate-500">
            <tr>
              <th className="p-3">رقم الطلب</th>
              <th className="p-3">العميل</th>
              <th className="p-3">المنتج</th>
              <th className="p-3">الكمية</th>
              <th className="p-3">الإجمالي</th>
              <th className="p-3">الحالة</th>
              <th className="p-3">التأكيد</th>
              <th className="p-3">التاريخ</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-slate-50 hover:bg-slate-50">
                <td className="p-3">
                  <Link href={`/orders/${o.id}`} className="font-medium text-brand-600 hover:underline" dir="ltr">
                    {o.orderNumber}
                  </Link>
                </td>
                <td className="p-3">{o.customer.name ?? o.customer.phone ?? "—"}</td>
                <td className="p-3">{o.items[0]?.productNameSnapshot ?? "—"}</td>
                <td className="p-3 tabular-nums">{o.items[0]?.quantity ?? "—"}</td>
                <td className="p-3 tabular-nums" dir="ltr">{Number(o.total).toLocaleString()} {o.currency}</td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[o.status]}`}>{o.status}</span>
                </td>
                <td className="p-3 text-xs text-slate-500">{o.confirmationStatus}</td>
                <td className="p-3 text-xs text-slate-500">
                  {new Date(o.createdAt).toLocaleDateString("ar")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && orders.length === 0 && !error && (
          <p className="p-10 text-center text-sm text-slate-500">لا توجد طلبات.</p>
        )}
      </div>
    </div>
  );
}
