"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../ui/dialog";
import { cn } from "@/lib/cn";

/**
 * SEND FROM THE LIBRARY — THE ATTACH BUTTON'S REPLACEMENT.
 *
 * Three shelves, in this order: the conversation's product images first
 * (category PRODUCT), then the library, then customer reviews. Customer
 * inbound never appears in any of them — the list doors exclude it
 * server-side, not by hiding rows here. Review photos are hand-picked
 * only, never automatic, and the tab says to check the photo carries no
 * customer name or phone before sending.
 *
 * The send itself goes through the normal human-reply door
 * (POST messages → dispatchOutbound), so the 24h policy, idempotency
 * and channel rules all still apply. Optional text travels with the
 * photo; the picker never sends on its own.
 */

type Item = {
  id: string;
  url: string;
  title: string | null;
  type: string;
  mimeType: string;
  size: number;
  product?: { id: string; name: string } | null;
};

type Tab = "products" | "library" | "feedback";

const TABS: { key: Tab; label: string }[] = [
  { key: "products", label: "صور المنتجات" },
  { key: "library", label: "المكتبة" },
  { key: "feedback", label: "آراء الزبائن" },
];

async function loadTab(tab: Tab): Promise<Item[]> {
  const url =
    tab === "products"
      ? "/api/media?category=PRODUCT&type=IMAGE&limit=30"
      : tab === "library"
        ? "/api/media?type=IMAGE&limit=30"
        : "/api/media/feedback?limit=20";
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "تعذر التحميل");
  return (json.items || []) as Item[];
}

function thumb(m: Item, cls: string) {
  if (m.type === "IMAGE") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={m.url} alt={m.title ?? ""} className={cls} loading="lazy" />;
  }
  return <span className={cn(cls, "flex items-center justify-center bg-surface-3/60 text-xs font-semibold text-ink-subtle")}>{m.type}</span>;
}

export function MediaPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** The composer sends: photo travels with its optional text. */
  onPick: (mediaId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("products");
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (t: Tab) => {
    setItems(null);
    setFailed(false);
    try {
      setItems(await loadTab(t));
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (open) void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab ]);

  return (
    <Dialog open={open} onClose={onClose} title="أرسل من المكتبة">
      <div className="flex gap-1 border-b border-line/60 pb-2" role="tablist" aria-label="مصدر الصورة">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all",
              tab === t.key ? "bg-primary-soft text-primary" : "text-ink-muted hover:bg-surface-3 hover:text-ink"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "feedback" && (
        <p className="mt-2 rounded-xl bg-amber-500/[0.08] p-2 text-[11px] font-semibold leading-relaxed text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300" role="alert">
          ⚠️ تأكد إنه الصورة ما فيها اسم أو رقم الزبون — صور الآراء يدوية فقط ولا تُرسل تلقائيًا أبدًا.
        </p>
      )}

      <div className="mt-2 max-h-72 overflow-y-auto">
        {failed && <p className="p-3 text-xs text-red-600 dark:text-red-400">تعذر التحميل — أعد المحاولة.</p>}
        {!failed && items === null && <p className="p-3 text-xs text-ink-muted">جارٍ التحميل…</p>}
        {!failed && items !== null && items.length === 0 && (
          <p className="p-3 text-xs text-ink-muted">لا صور هنا بعد.</p>
        )}
        {!failed && items !== null && items.length > 0 && (
          <div className="grid grid-cols-3 gap-2 p-1">
            {items.map((m) => (
              <button
                key={m.id}
                onClick={() => onPick(m.id)}
                className="group overflow-hidden rounded-xl border border-line/60 text-start transition hover:border-brand-500"
                title={m.title ?? m.id}
              >
                {thumb(m, "h-20 w-full object-cover")}
                <p className="truncate px-1.5 py-1 text-[10px] font-semibold text-ink">
                  {m.title ?? m.product?.name ?? m.id.slice(0, 8)}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
