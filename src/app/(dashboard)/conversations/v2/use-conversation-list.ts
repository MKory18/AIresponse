"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useRealtime } from "@/components/realtime/use-realtime";
import type { ConversationListItem } from "@/components/inbox/types";
import { appendPage, listParams, mergeFirstPage, type Filters, type ViewTab } from "./model";

interface Page {
  items: ConversationListItem[];
  nextCursor: string | null;
  total: number;
}

const LIVE_THROTTLE_MS = 4_000;

/**
 * قائمة المحادثات (3.1): تبويب + بحث + فلاتر من الخادم، تمرير بمؤشّر + العدد الكلي.
 * **التحديث الحي بيدمج الصفحة الأولى** (ما بيمسح المحمّل ولا بيرجّع القائمة للأول). `?id=` لمحادثة خارج الصفحة
 * المحمّلة بتنجاب لحالها (`extra`) وبتنعرض بأول القائمة بدل ما تفتح فاضية.
 */
export function useConversationList(view: ViewTab, q: string, filters: Filters, selectedId: string | null) {
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState<ConversationListItem | null>(null);
  const seq = useRef(0);
  const lastLive = useRef(0);

  const loadFirst = useCallback(
    async (opts: { reset: boolean }) => {
      const mine = ++seq.current;
      try {
        const page = await api<Page>(`/api/conversations?${listParams({ view, q, filters })}`);
        if (mine !== seq.current) return; // طلب أحدث سبقه
        setItems((prev) => (opts.reset ? page.items : mergeFirstPage(prev, page.items)));
        if (opts.reset) setCursor(page.nextCursor);
        setTotal(page.total);
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : "تعذّر تحميل المحادثات");
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [view, q, filters]
  );

  // تغيّر التبويب/البحث/الفلاتر = قائمة جديدة (البحث بيتأخر 300ms).
  useEffect(() => {
    setLoading(true);
    const id = setTimeout(() => void loadFirst({ reset: true }), q ? 300 : 0);
    return () => clearTimeout(id);
  }, [loadFirst, q]);

  const refresh = useCallback(() => loadFirst({ reset: false }), [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<Page>(`/api/conversations?${listParams({ view, q, filters, cursor })}`);
      setItems((prev) => appendPage(prev, page.items));
      setCursor(page.nextCursor);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر تحميل المزيد");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, view, q, filters]);

  // محادثة مفتوحة برابط وهي مش بالمحمّل: بنجيبها لحالها.
  const inList = selectedId ? items.some((c) => c.id === selectedId) : true;
  useEffect(() => {
    if (!selectedId || inList) {
      setExtra(null);
      return;
    }
    let alive = true;
    api<Page>(`/api/conversations?${listParams({ view: "all", q: "", filters: { status: "", channelId: "", assignee: "" }, ids: [selectedId] })}`)
      .then((p) => alive && setExtra(p.items[0] ?? null))
      .catch(() => alive && setExtra(null));
    return () => {
      alive = false;
    };
  }, [selectedId, inList]);

  useRealtime(() => {
    const now = Date.now();
    if (now - lastLive.current < LIVE_THROTTLE_MS) return;
    lastLive.current = now;
    void refresh();
  });
  // احتياطي إذا SSE انقطع.
  useEffect(() => {
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const markRead = useCallback((id: string) => setItems((prev) => prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c))), []);
  const remove = useCallback((id: string) => setItems((prev) => prev.filter((c) => c.id !== id)), []);

  const selected = (selectedId && (items.find((c) => c.id === selectedId) ?? extra)) || null;
  return { items, total, loading, loadingMore, error, hasMore: cursor !== null, loadMore, refresh, selected, markRead, remove };
}
