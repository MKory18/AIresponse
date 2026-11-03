"use client";

import { useEffect, useRef } from "react";

export type RealtimeChange = {
  type: string;
  conversationId: string | null;
  entityId: string | null;
  at: string;
};

/**
 * اتصال SSE بالمحادثات اللحظية.
 *
 * - يعيد الاتصال تلقائيًا بتراجع أسّي (1s → 30s) بلا تدخّل.
 * - يبعت `onChange` بأحدث نسخة من الدالة (ref) — من غير إعادة اشتراك.
 * - إذا SSE غير مدعوم، `onError` بيخلّي الصفحة تعتمد على polling احتياطي.
 */
export function useRealtime(
  onChange: (change: RealtimeChange) => void,
  opts?: { onStatus?: (status: "open" | "closed") => void }
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onStatusRef = useRef(opts?.onStatus);
  onStatusRef.current = opts?.onStatus;

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      onStatusRef.current?.("closed");
      return;
    }
    let source: EventSource | null = null;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      source = new EventSource("/api/events");
      source.addEventListener("open", () => {
        retries = 0;
        onStatusRef.current?.("open");
      });
      source.addEventListener("change", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as RealtimeChange;
          if (data && typeof data.type === "string") onChangeRef.current(data);
        } catch {
          // حدث مشوّه — تجاهل
        }
      });
      source.addEventListener("error", () => {
        onStatusRef.current?.("closed");
        source?.close();
        source = null;
        if (stopped) return;
        retries = Math.min(retries + 1, 5);
        const delay = Math.min(30_000, 1000 * 2 ** retries);
        timer = setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, []);
}
