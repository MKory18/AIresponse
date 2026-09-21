"use client";

import { useCallback, useEffect, useState } from "react";

type ProductRow = {
  productId: string;
  productName: string;
  units: number;
  confirmedOrders: number;
  deliveredOrders: number;
  confirmedRevenue: number;
  deliveredRevenue: number;
};

type SortKey = "units" | "confirmedRevenue" | "confirmedOrders";

export default function ProductAnalyticsPage() {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [sort, setSort] = useState<SortKey>("units");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/analytics/products?range=last_30_days");
    if (res.ok) setRows(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sorted = [...rows].sort((a, b) => (b[sort] as number) - (a[sort] as number));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">تحليلات المنتجات</h1>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="units">ترتيب حسب: الكميات</option>
          <option value="confirmedRevenue">ترتيب حسب: الإيرادات المؤكدة</option>
          <option value="confirmedOrders">ترتيب حسب: الطلبات المؤكدة</option>
        </select>
      </div>
      <p className="text-xs text-slate-500">آخر 30 يومًا — الأسعار من snapshots الطلبات (وليس سعر المنتج الحالي).</p>
      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-right text-sm">
          <thead className="border-b border-slate-100 text-xs text-slate-500">
            <tr>
              <th className="p-3">المنتج</th>
              <th className="p-3">الكميات</th>
              <th className="p-3">طلبات مؤكدة</th>
              <th className="p-3">إيرادات مؤكدة</th>
              <th className="p-3">طلبات مُسلّمة</th>
              <th className="p-3">إيرادات مُسلّمة</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.productId} className="border-b border-slate-50">
                <td className="p-3 font-medium">{r.productName}</td>
                <td className="p-3 tabular-nums">{r.units}</td>
                <td className="p-3 tabular-nums">{r.confirmedOrders}</td>
                <td className="p-3 tabular-nums">{r.confirmedRevenue.toLocaleString()}</td>
                <td className="p-3 tabular-nums">{r.deliveredOrders}</td>
                <td className="p-3 tabular-nums">{r.deliveredRevenue.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && sorted.length === 0 && <p className="p-10 text-center text-sm text-slate-500">لا توجد بيانات.</p>}
      </div>
    </div>
  );
}
