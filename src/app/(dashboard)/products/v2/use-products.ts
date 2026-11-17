"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type { Missing } from "@/modules/products/readiness";
import type { StatusFilter } from "./model";

export interface ProductRow {
  id: string;
  name: string;
  sku: string;
  price: string;
  currency: string;
  stockStatus: string;
  isActive: boolean;
  isArchived: boolean;
  mediaLinks: { mediaAsset: { url: string; type: string } }[];
  readiness: { ready: boolean; missing: Missing[] };
}

interface ListResponse {
  items: ProductRow[];
  nextCursor: string | null;
  total: number;
  oms: { connected: boolean; lastSyncAt: string | null };
}

/** قائمة المنتجات: الفلتر والبحث من الخادم، والعدد الكلي من الخادم، «حمّل المزيد» بمؤشّر، وتبديل «شغّال» فوري (تفاؤلي). */
export function useProducts(status: StatusFilter, query: string) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [oms, setOms] = useState<ListResponse["oms"]>({ connected: false, lastSyncAt: null });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const params = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ limit: "25", status, ...extra });
      if (query.trim().length >= 2) p.set("q", query.trim());
      return p.toString();
    },
    [status, query]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api<ListResponse>(`/api/products?${params()}`);
      if (mine !== seq.current) return;
      setRows(r.items);
      setTotal(r.total);
      setCursor(r.nextCursor);
      setOms(r.oms);
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

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<ListResponse>(`/api/products?${params({ cursor })}`);
      setRows((prev) => [...prev, ...r.items.filter((n) => !prev.some((p) => p.id === n.id))]);
      setCursor(r.nextCursor);
      setTotal(r.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر التحميل");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, params]);

  /** تعديل صف: يتحرك فورًا، وبيرجع لحاله لو الخادم رفض. */
  const patch = useCallback(
    async (id: string, body: { isActive?: boolean; isArchived?: boolean }): Promise<string | null> => {
      const before = rows;
      setRows((prev) => prev.map((p) => (p.id === id ? { ...p, ...body } : p)));
      try {
        await api(`/api/products/${id}`, { method: "PATCH", json: body });
        if (body.isArchived !== undefined || (body.isActive !== undefined && status !== "archived")) void load();
        return null;
      } catch (e) {
        setRows(before);
        return e instanceof Error ? e.message : "تعذّر الحفظ";
      }
    },
    [rows, status, load]
  );

  return { rows, total, hasMore: cursor !== null, oms, loading, loadingMore, error, reload: load, loadMore, patch };
}
