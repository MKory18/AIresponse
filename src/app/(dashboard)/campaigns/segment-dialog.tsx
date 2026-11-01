"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

/**
 * شريحة جديدة بشروط جاهزة بيفهمها صاحب المتجر.
 *
 * ⚠️ قبل: ولا مكان بالموقع بينشئ شريحة (`POST /api/segments` موجود بلا واجهة)،
 * والصفحة بتقول «أنشئها عبر واجهة الشرائح» الي مش موجودة — فزر «إنشاء حملة»
 * بيضل معطّل للأبد.
 * 🔧 خيارات جاهزة (مربعات) بتنبني منها شروط مغلقة من نفس مخطط الخادم
 * (`segment-schemas.ts`) — بلا كتابة شروط يدوي. كل الشروط المختارة لازم تتحقق مع بعض.
 */

type Condition = Record<string, unknown>;

export const SEGMENT_PRESETS: { key: string; label: string; hint: string; condition: Condition }[] = [
  {
    key: "consent",
    label: "وافقوا يستقبلوا رسائل تسويقية",
    hint: "الأفضل يضل مختار — الحملة ما بتوصل للي ما وافق أصلًا.",
    condition: { field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" },
  },
  {
    key: "buyers",
    label: "طلبوا منك قبل",
    hint: "زبائنك الحاليين — عرض جديد أو منتج مكمّل.",
    condition: { field: "orders.hasAny", op: "EQ", value: true },
  },
  {
    key: "never",
    label: "حكوا معك بس ما طلبوا",
    hint: "مهتمين ما كملوا — تذكير أو خصم.",
    condition: { field: "orders.hasAny", op: "EQ", value: false },
  },
  {
    key: "recent",
    label: "حكوا معك آخر ٧ أيام",
    hint: "المحادثة لسا سخنة.",
    condition: { field: "customer.lastContact", op: "WITHIN_DAYS", days: 7 },
  },
  {
    key: "dormant",
    label: "ما حكوا معك من ٣٠ يوم أو أكتر",
    hint: "رجّعهم بعرض.",
    condition: { field: "customer.lastContact", op: "OLDER_THAN_DAYS", days: 30 },
  },
  {
    key: "cap",
    label: "ما وصلتهم حملة آخر ٧ أيام",
    hint: "حتى ما تزعجهم برسائل ورا بعض.",
    condition: { field: "campaign.notReceivedWithinDays", op: "EQ", days: 7 },
  },
];

export function SegmentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(["consent", "cap"]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const conditions = SEGMENT_PRESETS.filter((p) => picked.has(p.key)).map((p) => p.condition);
    if (conditions.length === 0) {
      setError("اختر شرط واحد على الأقل.");
      return;
    }
    if (picked.has("buyers") && picked.has("never")) {
      setError("«طلبوا قبل» و«ما طلبوا» ما بيجتمعوا — اختر وحدة.");
      return;
    }
    if (picked.has("recent") && picked.has("dormant")) {
      setError("«آخر ٧ أيام» و«من ٣٠ يوم» ما بيجتمعوا — اختر وحدة.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), definition: { version: 1, match: "ALL", conditions } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? "فشل إنشاء الشريحة");
        return;
      }
      const { id } = (await res.json()) as { id: string };
      setName("");
      onCreated(id);
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="شريحة جديدة — مين بدك توصله؟">
      <form onSubmit={save} className="space-y-3">
        <Field label="اسم الشريحة">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: زبائن ما طلبوا من شهر" />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-bold text-ink">الشروط (كلها مع بعض)</legend>
          {SEGMENT_PRESETS.map((p) => (
            <label
              key={p.key}
              className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line px-3 py-2 transition-colors hover:bg-surface-hover"
            >
              <input type="checkbox" checked={picked.has(p.key)} onChange={() => toggle(p.key)} className="mt-1 h-4 w-4 accent-brand-500" />
              <span>
                <span className="block text-sm font-semibold text-ink">{p.label}</span>
                <span className="block text-[11px] text-ink-muted">{p.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>إلغاء</Button>
          <Button type="submit" loading={saving} disabled={!name.trim()}>حفظ الشريحة</Button>
        </div>
      </form>
    </Dialog>
  );
}
