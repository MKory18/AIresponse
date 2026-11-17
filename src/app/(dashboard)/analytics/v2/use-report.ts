"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type { ReportResponse } from "@/modules/analytics/reports";
import { reportQuery, type ReportParams } from "./model";

/** جلب التقرير: بيحافظ على آخر نتيجة لما فشل التحديث، وبيتجاهل ردود الطلبات القديمة (تبديل سريع بين التبويبات). */
export function useReport(params: ReportParams) {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const query = reportQuery(params);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await api<ReportResponse>(`/api/reports?${query}`);
      if (mine !== seq.current) return;
      setData(r);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "تعذّر التحميل");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load, query };
}
