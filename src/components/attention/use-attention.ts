"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { AttentionResult } from "@/modules/attention/service";

const POLL_MS = 30_000;
const EMPTY: AttentionResult = { items: [], counts: { total: 0, critical: 0 }, banner: null };

/**
 * «يحتاجك» للواجهة (2.3): جلب `/api/attention` + استطلاع كل 30 ثانية + تحديث عند رجوع التركيز للتبويب.
 * الخادم بيخبّي 15 ثانية، فالاستطلاع رخيص. فشل الجلب ما بيمسح آخر نتيجة ولا بيطلع خطأ — الشريط مش مكان للأعطال.
 */
export function useAttention(enabled = true): { data: AttentionResult; loaded: boolean; refresh: () => void } {
  const [data, setData] = useState<AttentionResult>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    api<AttentionResult>("/api/attention")
      .then((r) => {
        setData(r);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  return { data, loaded, refresh };
}
