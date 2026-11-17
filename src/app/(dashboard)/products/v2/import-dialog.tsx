"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Num } from "@/components/ui/formatted";
import { PRODUCTS_STRINGS as S } from "./strings";

interface Summary {
  usedAI: boolean;
  aiError: string | null;
  created: { id: string; name: string; sku: string; price: string; priceTiers: { label: string; price: string }[] }[];
  skipped: { row: number; reason: string }[];
}

/**
 * «استيراد اكسل»: رفع ملف، وتحليل الأعمدة (بالوكيل أو محليًا)، وملخص: اللي انضاف واللي انتخطّى مع السبب.
 * ⚠️ الاستيراد بيرفع أسماء وأسعار منتجات بس (ولا بيانات عملاء).
 */
export function ImportProductsDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const I = S.import_;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Summary | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/products/import", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `${I.failed} (${res.status})`);
        return;
      }
      setResult((await res.json()) as Summary);
      onDone();
    } catch {
      setError(I.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={I.title} className="max-w-lg">
      <div className="space-y-3">
        <p className="text-sm leading-relaxed text-ink-muted">{I.help}</p>
        <input
          type="file"
          accept=".xlsx,.csv"
          disabled={busy}
          aria-label={S.import}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
          className="block w-full text-sm text-ink file:me-3 file:rounded-control file:border file:border-border-strong file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-ink"
        />
        {busy && <p className="rounded-control bg-info-soft px-3 py-2 text-sm text-info">{I.working}</p>}
        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {result && (
          <div className="space-y-2">
            <p className="rounded-control bg-success-soft px-3 py-2 text-sm text-success">
              انضاف {result.created.length} منتج — {result.usedAI ? "تحليل الأعمدة بالوكيل" : "تحليل الأعمدة محلي"}.
              {result.skipped.length > 0 ? ` وانتخطّى ${result.skipped.length} صف (التفاصيل تحت).` : ""}
            </p>
            {result.aiError && <Callout risk={`ملاحظة التحليل: ${result.aiError}`} fix="راجع أسماء الأعمدة بالملف، أو عدّل المنتجات المنضافة يدويًا." />}
            <ul className="max-h-48 overflow-y-auto rounded-card border border-line">
              {result.created.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-sm last:border-0">
                  <span className="min-w-0 truncate text-ink">{p.name}</span>
                  <span className="shrink-0 text-ink-muted">
                    <Num value={p.price} maxFraction={2} />
                    {p.priceTiers.length > 0 ? ` + ${p.priceTiers.length} سعر` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {result.skipped.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-card border border-warning/40 bg-warning-soft">
                {result.skipped.map((s) => (
                  <li key={s.row} className="border-b border-warning/20 px-3 py-1.5 text-sm text-ink last:border-0">
                    {I.skipped} {s.row} · {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {I.close}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
