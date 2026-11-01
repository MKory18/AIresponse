"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

const OPTIONAL = [
  { key: "phone", label: "رقم الهاتف" },
  { key: "address", label: "العنوان" },
  { key: "name", label: "اسم الزبون" },
] as const;

/**
 * P19 — بيانات إكمال الطلب لكل صفحة.
 *
 * المنتج والكمية دائمًا مطلوبان (خادميًا). المالك يختار حقول الاتصال
 * (هاتف/عنوان/اسم)؛ لما تكتمل هذه الحقول تصير المسودة READY وتُرسل
 * لمجموعة تيليجرام (إذا كان الإرسال مفعّلًا).
 */
export function OrderFieldsSection({ channelId }: { channelId: string }) {
  const [selected, setSelected] = useState<string[]>(["phone", "address"]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/channels/by-id/${channelId}/order-fields`);
      if (!res.ok) return;
      const data = (await res.json()) as { fields?: string[] };
      setSelected((data.fields ?? []).filter((f) => f !== "product" && f !== "quantity"));
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(key: string) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/channels/by-id/${channelId}/order-fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: ["product", "quantity", ...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "تعذّر الحفظ");
      setMessage("تم الحفظ ✓");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="mt-3 rounded-xl bg-surface-2/60 p-2.5 dark:bg-white/[0.02]">
      <p className="flex items-center gap-1.5 text-xs font-bold text-ink">
        <ClipboardCheck size={13} />
        بيانات إكمال الطلب لهذه الصفحة
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
        المنتج والكمية مطلوبان دائمًا. اختَر شو كمان لازم يتعبّى قبل ما تصير المسودة جاهزة:
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {OPTIONAL.map((f) => (
          <label key={f.key} className="flex items-center gap-1.5 text-[11px] font-medium text-ink">
            <input
              type="checkbox"
              checked={selected.includes(f.key)}
              onChange={() => toggle(f.key)}
              className="h-3.5 w-3.5 accent-[var(--color-primary)]"
            />
            {f.label}
          </label>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => void save()} loading={busy} disabled={busy}>
          حفظ
        </Button>
        {message && <span className="text-[11px] text-ink-muted">{message}</span>}
      </div>
    </div>
  );
}
