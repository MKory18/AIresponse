"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

type OrderDetail = {
  id: string;
  orderNumber: string;
  status: string;
  confirmationStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  subtotal: string;
  discount: string;
  deliveryFee: string;
  total: string;
  currency: string;
  province: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  createdAt: string;
  customer: { id: string; name: string | null; phone: string | null };
  items: { id: string; productNameSnapshot: string; skuSnapshot: string; unitPrice: string; quantity: number; subtotal: string }[];
  timeline: { id: string; action: string; metadata: Record<string, unknown>; createdAt: string }[];
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  NEW: ["CONFIRMED", "CANCELLED"],
  CONFIRMATION_PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["OUT_FOR_DELIVERY", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: ["RETURNED"],
};

const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/${params.id}`);
    if (!res.ok) {
      setError("الطلب غير موجود");
      return;
    }
    setOrder(await res.json());
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeStatus(status: string) {
    setSaving(true);
    const res = await fetch(`/api/orders/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "انتقال غير مسموح");
    }
    load();
  }

  if (error && !order) return <p className="text-sm text-red-600">{error}</p>;
  if (!order) return <p className="text-sm text-slate-400">جارٍ التحميل…</p>;

  const transitions = ALLOWED_TRANSITIONS[order.status] ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold" dir="ltr">{order.orderNumber}</h1>
          <p className="text-xs text-slate-500">{order.createdAt && new Date(order.createdAt).toLocaleString("ar")}</p>
        </div>
        <div className="flex items-center gap-2">
          {transitions.map((t) => (
            <button
              key={t}
              onClick={() => changeStatus(t)}
              disabled={saving}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                t === "CANCELLED" ? "border border-red-300 text-red-600 hover:bg-red-50" : "border border-slate-300 text-slate-700 hover:bg-slate-50"
              } disabled:opacity-50`}
            >
              → {t}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-700">البنود</h2>
            {order.items.map((i) => (
              <div key={i.id} className="flex items-center justify-between border-b border-slate-50 py-2 text-sm">
                <div>
                  <p className="font-medium">{i.productNameSnapshot}</p>
                  <p className="text-xs text-slate-400" dir="ltr">{i.skuSnapshot}</p>
                </div>
                <div className="text-left" dir="ltr">
                  <p>{Number(i.unitPrice).toLocaleString()} × {i.quantity}</p>
                  <p className="text-xs text-slate-500">{Number(i.subtotal).toLocaleString()} {order.currency}</p>
                </div>
              </div>
            ))}
            <div className="mt-3 space-y-1 text-sm" dir="ltr">
              <p className="flex justify-between"><span>Subtotal</span><span>{Number(order.subtotal).toLocaleString()}</span></p>
              <p className="flex justify-between"><span>Discount</span><span>{Number(order.discount).toLocaleString()}</span></p>
              <p className="flex justify-between"><span>Delivery</span><span>{Number(order.deliveryFee).toLocaleString()}</span></p>
              <p className="flex justify-between font-bold"><span>Total</span><span>{Number(order.total).toLocaleString()} {order.currency}</span></p>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-700">السجل الزمني (Audit)</h2>
            {order.timeline.map((t) => (
              <div key={t.id} className="border-b border-slate-50 py-2 text-xs">
                <p className="font-medium text-slate-700">{t.action}</p>
                <p className="text-slate-400">{new Date(t.createdAt).toLocaleString("ar")}</p>
              </div>
            ))}
            {order.timeline.length === 0 && <p className="text-xs text-slate-400">لا يوجد سجل.</p>}
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-3 text-sm font-bold text-slate-700">العميل</h2>
            <p className="font-medium">{order.customer.name ?? "—"}</p>
            <p className="text-xs text-slate-500" dir="ltr">{order.customer.phone ?? ""}</p>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-3 text-sm font-bold text-slate-700">التوصيل</h2>
            <p className="text-xs text-slate-500">العنوان</p>
            <p>{order.deliveryAddress ?? "—"}</p>
            <p className="mt-2 text-xs text-slate-500">المحافظة</p>
            <p>{order.province ?? "—"}</p>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-xs">
            <h2 className="mb-2 text-sm font-bold text-slate-700">الحالات</h2>
            <p>Order: {order.status}</p>
            <p>Confirmation: {order.confirmationStatus}</p>
            <p>Payment: {order.paymentStatus}</p>
            <p>Fulfillment: {order.fulfillmentStatus}</p>
          </section>
        </div>
      </div>
      <div className="flex gap-2">{/* reserved: conversation link */}</div>
    </div>
  );
}
