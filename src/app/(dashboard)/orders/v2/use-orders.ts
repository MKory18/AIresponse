"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useRealtime } from "@/components/realtime/use-realtime";
import type { OrderTab } from "@/lib/order-status";

export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  total: string;
  currency: string;
  createdAt: string;
  updatedAt?: string;
  settleAt?: string | null;
  sealedAt?: string | null;
  heldBy?: string | null;
  omsStatus?: string | null;
  omsShippingStatus?: string | null;
  conversationId?: string | null;
  customer: { id: string; name: string | null; phone: string | null };
  items: { productNameSnapshot: string; quantity: number }[];
}

interface ListResponse {
  items: OrderRow[];
  nextCursor: string | null;
  total: number;
}
export type Counts = Record<OrderTab, number>;
const EMPTY_COUNTS: Counts = { all: 0, review: 0, awaiting: 0, sealed: 0, cancelled: 0 };
const LIVE_THROTTLE_MS = 15_000;

/**
 * قائمة الطلبات الجديدة (3.2): التبويب والبحث من الخادم، **العدّادات والعدد الكلي من الخادم**، «حمّل المزيد» بمؤشّر (cursor).
 * البحث بيتأخر 300ms. حي بـSSE (تحديث على الأكثر كل 15 ثانية) — بدون ما يختفي اللي محمّل.
 */
export function useOrders(tab: OrderTab, query: string) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastLive = useRef(0);
  const seq = useRef(0);

  const params = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ limit: "25", ...extra });
      if (tab !== "all") p.set("tab", tab);
      if (query.trim().length >= 2) p.set("q", query.trim());
      return p.toString();
    },
    [tab, query]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [list, c] = await Promise.all([api<ListResponse>(`/api/orders?${params()}`), api<{ counts: Counts }>("/api/orders/counts")]);
      if (mine !== seq.current) return; // طلب أحدث سبقه
      setRows(list.items);
      setTotal(list.total);
      setCursor(list.nextCursor);
      setCounts(c.counts);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : "تعذّر التحميل");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    setLoading(true);
    const id = setTimeout(() => void load(), query ? 300 : 0);
    return () => clearTimeout(id);
  }, [load, query]);

  useRealtime(() => {
    const now = Date.now();
    if (now - lastLive.current < LIVE_THROTTLE_MS) return;
    lastLive.current = now;
    void load();
  });

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await api<ListResponse>(`/api/orders?${params({ cursor })}`);
      setRows((prev) => [...prev, ...more.items.filter((o) => !prev.some((p) => p.id === o.id))]);
      setCursor(more.nextCursor);
      setTotal(more.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر التحميل");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, params]);

  return { rows, total, counts, loading, loadingMore, error, hasMore: cursor !== null, loadMore, reload: load };
}
