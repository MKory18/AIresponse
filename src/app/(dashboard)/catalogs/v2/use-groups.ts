"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { ChannelRow } from "../../channels/v2/model";

export interface Group {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  products: number;
  pages: number;
}

/**
 * مجموعات المنتجات + الصفحات (القنوات) بتحميل واحد. كل فعل بيرجّع `null` لو نجح أو رسالة الخطأ.
 * الحذف: لو آخر مجموعة وفيها صفحات الخادم بيرد 409 — الواجهة بتسأل تأكيد صريح وبتعيد بـ`force`.
 */
export function useGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [pages, setPages] = useState<ChannelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [g, c] = await Promise.allSettled([api<{ catalogs: Group[] }>("/api/catalogs?sort=name"), api<{ channels: ChannelRow[] }>("/api/channels")]);
    if (g.status === "fulfilled") {
      setGroups(g.value.catalogs);
      setError(null);
    } else setError(g.reason instanceof Error ? g.reason.message : "تعذّر التحميل");
    if (c.status === "fulfilled") setPages(c.value.channels.filter((x) => x.type !== "WEB"));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<string | null> => {
      try {
        await fn();
        await load();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "تعذّر الحفظ";
      }
    },
    [load]
  );

  return {
    groups,
    pages,
    loading,
    error,
    reload: load,
    /** اختيار مجموعة للصفحة (فاضي = فصلها عن مجموعتها). */
    assign: (page: ChannelRow, groupId: string) =>
      run(() =>
        groupId
          ? api(`/api/catalogs/${groupId}/pages`, { method: "POST", json: { channelId: page.id } })
          : api(`/api/catalogs/${page.catalog?.id}/pages`, { method: "DELETE", json: { channelId: page.id } })
      ),
    toggle: (g: Group, isActive: boolean) => run(() => api(`/api/catalogs/${g.id}`, { method: "PATCH", json: { isActive } })),
    create: (name: string, description: string) => run(() => api("/api/catalogs", { method: "POST", json: { name: name.trim(), description: description.trim() || null } })),
    /** يرجّع "force" لو الخادم طلب تأكيدًا صريحًا (آخر مجموعة وفيها صفحات). */
    remove: async (g: Group, force: boolean): Promise<string | null | "force"> => {
      try {
        await api(`/api/catalogs/${g.id}${force ? "?force=1" : ""}`, { method: "DELETE" });
        await load();
        return null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && !force) return "force";
        return e instanceof Error ? e.message : "تعذّر الحذف";
      }
    },
  };
}
