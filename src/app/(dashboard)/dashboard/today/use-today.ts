"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useRealtime } from "@/components/realtime/use-realtime";
import type { TodayData } from "@/modules/today/service";
import type { TodayRange } from "@/modules/today/range";

const POLL_MS = 30_000;
const LIVE_THROTTLE_MS = 15_000;

/** بيانات «اليوم»: جلب + حي عبر SSE (بتحديث على الأكثر كل 15 ثانية) + استطلاع احتياطي 30 ثانية. فشل الجلب بيحافظ على آخر نتيجة. */
export function useToday(range: TodayRange) {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastLive = useRef(0);

  const load = useCallback(async () => {
    try {
      setData(await api<TodayData>(`/api/today?range=${range}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر التحميل");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useRealtime(() => {
    const now = Date.now();
    if (now - lastLive.current < LIVE_THROTTLE_MS) return;
    lastLive.current = now;
    void load();
  });

  return { data, error, loading, reload: load };
}
