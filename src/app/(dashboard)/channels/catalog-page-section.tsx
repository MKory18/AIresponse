"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";

type CatalogInfo = {
  channel: { id: string; displayName: string } | null;
  assignment: { id: string; catalogId: string } | null;
  catalog: { id: string; name: string; isActive: boolean } | null;
  status: "ok" | "no_assignment" | "catalog_inactive" | "no_catalogs" | "no_channel";
  products: { id: string; name: string }[];
};

type CatalogOption = { id: string; name: string };

/**
 * كتالوج المنتجات — WHICH PRODUCTS THIS PAGE ANSWERS WITH.
 *
 * Mounted inside each Facebook connection card: the active catalog, how
 * many products the AI may use for this page, the link state, and the
 * three moves — change the catalog (atomic switch with confirmation),
 * manage its products, preview it. A page with no catalog says so out
 * loud instead of silently answering from everywhere.
 */
export function CatalogPageSection({ channelId, pageName }: { channelId: string; pageName: string | null }) {
  const toast = useToast();
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [options, setOptions] = useState<CatalogOption[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [infoRes, listRes] = await Promise.all([
        fetch(`/api/channels/by-id/${channelId}/catalog`),
        fetch("/api/catalogs?sort=name"),
      ]);
      if (infoRes.ok) setInfo(await infoRes.json());
      else setFailed(true);
      if (listRes.ok) {
        const json = await listRes.json();
        setOptions((json.catalogs ?? []).map((c: CatalogOption) => ({ id: c.id, name: c.name })));
      }
    } catch {
      setFailed(true);
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function change() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/catalogs/${selected}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر التبديل");
      toast.show("تبدّل كتالوج الصفحة — يجيب الذكاء منه الآن", "success");
      setSelected("");
      setConfirming(false);
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر التبديل", "error");
    } finally {
      setBusy(false);
    }
  }

  if (failed || !info) {
    return failed ? (
      <p className="mt-3 text-xs text-ink-subtle">تعذر تحميل الكتالوج — أعد تحميل الصفحة.</p>
    ) : null;
  }

  return (
    <div className="mt-3 rounded-xl bg-surface-2/60 p-2.5 dark:bg-white/[0.02]">
      <p className="text-xs font-bold text-ink">كتالوج المنتجات</p>
      {info.status === "ok" && info.catalog ? (
        <>
          <p className="mt-1 text-xs text-ink-muted">
            النشط: <strong className="text-ink">{info.catalog.name}</strong> · {info.products.length} منتج متاح للرد
            {!info.catalog.isActive && <span className="font-semibold text-amber-600"> · متوقف — لا يُستخدم</span>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Link href={`/catalogs/${info.catalog.id}`} className="text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-300">
              إدارة المنتجات
            </Link>
            <Link href={`/catalogs/${info.catalog.id}`} className="text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-300">
              معاينة الكتالوج
            </Link>
          </div>
        </>
      ) : (
        <p className="mt-1 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] font-semibold leading-relaxed text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300" role="alert">
          {info.status === "no_catalogs"
            ? "لا كتالوجات بعد — أنشئ واحدًا من «كتالوجات المنتجات» ثم اربطه هنا."
            : `«${pageName ?? "هذه الصفحة"}» بلا كتالوج نشط — الذكاء لا يستخدم أي منتج لها حتى تُسند.`}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="h-9 min-w-40 flex-1 rounded-xl border border-line bg-surface px-2.5 text-xs font-medium text-ink outline-none focus:border-brand-400"
          aria-label="تغيير الكتالوج"
        >
          <option value="">تغيير الكتالوج…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" onClick={() => setConfirming(true)} disabled={busy || !selected} loading={busy}>
          تبديل
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void change()}
        title="تبديل كتالوج الصفحة؟"
        body="سيجيب الذكاء عن هذه الصفحة من الكتالوج الجديد فقط. التبديل ذري — لن تبقى الصفحة بلا إعداد صالح."
        confirmLabel="بدّل الكتالوج"
        busy={busy}
        danger
      />
    </div>
  );
}
