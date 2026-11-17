"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { ChannelRow } from "./model";

export interface Option {
  id: string;
  name: string;
}
export type Setting = "mode" | "persona" | "market" | "catalog";

/**
 * قنوات المساحة: القائمة (مع السوق والمجموعة ونبض التوكن) + خيارات الشخصيات والمجموعات + هل ربط فيسبوك مضبوط.
 * كل إعداد بينحفظ فورًا (تفاؤلي) وبيرجع لحاله لو الخادم رفض. الخيارات اختيارية: فشلها ما بيوقف الصفحة.
 */
export function useChannels() {
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [personas, setPersonas] = useState<Option[]>([]);
  const [catalogs, setCatalogs] = useState<Option[]>([]);
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ch, pe, ca, fb] = await Promise.allSettled([
      api<{ channels: ChannelRow[] }>("/api/channels"),
      api<{ items?: Option[]; personas?: Option[] }>("/api/personas"),
      api<{ catalogs?: Option[] }>("/api/catalogs?sort=name"),
      api<{ oauthConfigured: boolean }>("/api/channels/facebook"),
    ]);
    if (ch.status === "fulfilled") {
      setRows(ch.value.channels.filter((c) => c.type !== "WEB"));
      setError(null);
    } else setError(ch.reason instanceof Error ? ch.reason.message : "تعذّر تحميل القنوات");
    if (pe.status === "fulfilled") setPersonas((pe.value.items ?? pe.value.personas ?? []).map((p) => ({ id: p.id, name: p.name })));
    if (ca.status === "fulfilled") setCatalogs((ca.value.catalogs ?? []).map((c) => ({ id: c.id, name: c.name })));
    if (fb.status === "fulfilled") setOauthConfigured(fb.value.oauthConfigured);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** يرجّع null لو نجح، أو رسالة الخطأ. */
  const save = useCallback(
    async (id: string, setting: Setting, value: string): Promise<string | null> => {
      const before = rows;
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          if (setting === "mode") return { ...r, sendMode: value };
          if (setting === "persona") return { ...r, aiPersonaId: value || null };
          if (setting === "market") return { ...r, market: value || null };
          return { ...r, catalog: catalogs.find((c) => c.id === value) ? { id: value, name: catalogs.find((c) => c.id === value)!.name, isActive: true } : r.catalog };
        })
      );
      try {
        if (setting === "mode") await api(`/api/channels/by-id/${id}/send-mode`, { method: "PATCH", json: { sendMode: value } });
        else if (setting === "persona") await api(`/api/channels/by-id/${id}/persona`, { method: "PATCH", json: { personaId: value || null } });
        else if (setting === "market") await api(`/api/channels/by-id/${id}`, { method: "PATCH", json: { market: value || null } });
        else await api(`/api/catalogs/${value}/pages`, { method: "POST", json: { channelId: id } });
        return null;
      } catch (e) {
        setRows(before);
        return e instanceof Error ? e.message : "تعذّر الحفظ";
      }
    },
    [rows, catalogs]
  );

  return { rows, personas, catalogs, oauthConfigured, loading, error, reload: load, save };
}
