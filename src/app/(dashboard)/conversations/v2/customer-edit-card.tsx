"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { CustomerDetail } from "@/components/inbox/types";

type Editable = CustomerDetail & { city?: string | null; canWrite?: boolean };
type Form = { name: string; phone: string; province: string; city: string; address: string; notes: string };

const toForm = (c: Editable): Form => ({
  name: c.name ?? "",
  phone: c.phone ?? "",
  province: c.province ?? "",
  city: c.city ?? "",
  address: c.address ?? "",
  notes: c.notes ?? "",
});

/** فقط الحقول اللي تغيّرت (الفاضي = مسح القيمة)، بالأسماء اللي بيقبلها `PATCH /api/customers/[id]`. */
export function changedFields(before: Form, after: Form): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(after) as Array<keyof Form>) {
    const next = after[k].trim();
    if (next !== before[k].trim()) out[k] = next === "" ? null : next;
  }
  return out;
}

/**
 * تعديل بيانات العميل من لوحة المحادثة (3.1ب): هاتف · اسم · محافظة · مدينة · عنوان · ملاحظات.
 * بيظهر بس لمن عنده `customers.write` (الخادم هو الحكم). كل تغيير بيتسجّل بالتدقيق قبل/بعد.
 * رقم مستعمل عند عميل تاني = رسالة واضحة. المحافظة بتحكم رسوم التوصيل — غلطة فيها بتغيّر سعر الطلب.
 */
export function CustomerEditCard({ customer, onSaved }: { customer: CustomerDetail; onSaved: (c: CustomerDetail) => void }) {
  const toast = useToast();
  const c = customer as Editable;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(() => toForm(c));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!c.canWrite) return null;

  const patch = changedFields(toForm(c), form);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/customers/${c.id}`, { method: "PATCH", json: patch });
      onSaved(await api<CustomerDetail>(`/api/customers/${c.id}`));
      toast.show("انحفظت بيانات العميل", "success");
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "هالرقم مستعمل عند عميل ثاني." : e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setForm(toForm(c));
          setError(null);
          setEditing(true);
        }}
      >
        <Pencil size={14} aria-hidden /> عدّل بيانات العميل
      </Button>
    );
  }
  return (
    <GlassCard className="space-y-3 p-3.5" data-customer-edit>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="الاسم">
          <Input value={form.name} maxLength={200} onChange={set("name")} />
        </Field>
        <Field label="الهاتف">
          <Input dir="ltr" inputMode="tel" value={form.phone} maxLength={32} onChange={set("phone")} />
        </Field>
        <Field label="المحافظة" hint="بتحكم رسوم التوصيل">
          <Input value={form.province} maxLength={100} onChange={set("province")} />
        </Field>
        <Field label="المدينة">
          <Input value={form.city} maxLength={100} onChange={set("city")} />
        </Field>
      </div>
      <Field label="العنوان">
        <Textarea rows={2} value={form.address} maxLength={500} onChange={set("address")} />
      </Field>
      <Field label="ملاحظات">
        <Textarea rows={2} value={form.notes} maxLength={5000} onChange={set("notes")} />
      </Field>
      {error && (
        <div role="alert" className="rounded-card border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-ink">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} loading={busy} disabled={busy || Object.keys(patch).length === 0}>
          احفظ
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
          ألغِ
        </Button>
      </div>
    </GlassCard>
  );
}
