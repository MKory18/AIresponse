"use client";

import { useCallback, useEffect, useState } from "react";
import { Package, Trophy } from "lucide-react";
import { formatNumber } from "@/lib/i18n";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { SkeletonTable } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

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
    <div className="page-wrap">
      <PageHeader
        title="تحليلات المنتجات"
        description="آخر 30 يومًا — الأسعار من snapshots الطلبات (وليس سعر المنتج الحالي)."
        actions={
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="ترتيب" className="w-56">
            <option value="units">ترتيب حسب: الكميات</option>
            <option value="confirmedRevenue">ترتيب حسب: الإيرادات المؤكدة</option>
            <option value="confirmedOrders">ترتيب حسب: الطلبات المؤكدة</option>
          </Select>
        }
      />
      {loading && (
        <GlassCard className="p-4">
          <SkeletonTable rows={6} />
        </GlassCard>
      )}
      {!loading && sorted.length > 0 && (
        <GlassCard className="overflow-hidden">
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
                      <span className="flex items-center gap-2 font-bold">
                        {i === 0 && <Trophy size={14} className="shrink-0 text-amber-500" />}
                        {r.productName}
                      </span>
                    </td>
                    <td className="num font-bold">{formatNumber(r.units)}</td>
                    <td className="num">{formatNumber(r.confirmedOrders)}</td>
                    <td className="num">{r.confirmedRevenue.toLocaleString()}</td>
                    <td className="num">{formatNumber(r.deliveredOrders)}</td>
                    <td className="num">{r.deliveredRevenue.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}
      {!loading && sorted.length === 0 && (
        <GlassCard>
          <EmptyState icon={<Package size={28} strokeWidth={1.5} />} title="لا توجد بيانات" description="ستظهر تحليلات المنتجات بعد تسجيل أول الطلبات." />
        </GlassCard>
      )}
    </div>
  );
}
