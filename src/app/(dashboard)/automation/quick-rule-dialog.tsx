"use client";

import { useState } from "react";
import { t, label as enumLabel } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

/**
 * قاعدة سريعة: «لما يصير X ابعت رسالة متابعة بعد Y ساعة» — أبسط شي وأكتره استعمالًا.
 * بتنحفظ شغّالة فورًا (نفس سلوك صفحة «القواعد» القديمة). للخطوات المتعددة: «قاعدة بخطوات».
 */

const TRIGGERS = [
  "ORDER_CREATED", "ORDER_CONFIRMED", "ORDER_CANCELLED", "ORDER_DELIVERED",
  "CONVERSATION_CREATED", "CUSTOMER_CREATED",
];

const EMPTY_FORM = {
  name: "", trigger: "ORDER_CONFIRMED", province: "", minTotal: "",
  followUpTemplate: "مرحبًا {{customer.name}}، نود التأكد من أن كل شيء على ما يرام مع طلبك.", delayHours: 24,
};

export function QuickRuleDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    const all: { field: string; operator: "EQ" | "GTE"; value?: string | number }[] = [];
    if (form.province) all.push({ field: "customer.province", operator: "EQ", value: form.province });
    if (form.minTotal) all.push({ field: "order.total", operator: "GTE", value: Number(form.minTotal) });

    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          trigger: form.trigger,
          conditions: all.length ? { all } : {},
          actions: [{ type: "CREATE_FOLLOW_UP", template: form.followUpTemplate, delayHours: Number(form.delayHours), followUpType: "CHECK_IN" }],
          priority: 0,
          isEnabled: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? "فشل الإنشاء");
        return;
      }
      setForm(EMPTY_FORM);
      onCreated();
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="قاعدة سريعة — رسالة متابعة تلقائية">
      <form onSubmit={create} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="اسم القاعدة">
          <Input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="مثال: متابعة بعد التأكيد" />
        </Field>
        <Field label="لما يصير">
          <Select value={form.trigger} onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}>
            {TRIGGERS.map((trigger) => <option key={trigger} value={trigger}>{enumLabel(trigger)}</option>)}
          </Select>
        </Field>
        <Field label="بس إذا المحافظة" hint="فاضي = كل المحافظات.">
          <Input value={form.province} onChange={(e) => setForm((f) => ({ ...f, province: e.target.value }))} placeholder="مثال: دمشق" />
        </Field>
        <Field label="بس إذا مجموع الطلب على الأقل" hint="فاضي = أي مجموع.">
          <Input type="number" value={form.minTotal} onChange={(e) => setForm((f) => ({ ...f, minTotal: e.target.value }))} dir="ltr" className="num" />
        </Field>
        <Field label="نص رسالة المتابعة" hint="{{customer.name}} = اسم العميل." className="sm:col-span-2">
          <Textarea value={form.followUpTemplate} onChange={(e) => setForm((f) => ({ ...f, followUpTemplate: e.target.value }))} rows={2} />
        </Field>
        <Field label="ابعتها بعد (ساعات)">
          <Input type="number" min="0" value={form.delayHours} onChange={(e) => setForm((f) => ({ ...f, delayHours: Number(e.target.value) }))} dir="ltr" className="num" />
        </Field>
        <div className="flex items-end justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" loading={creating}>إنشاء وتشغيل</Button>
        </div>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400 sm:col-span-2">{error}</p>}
      </form>
    </Dialog>
  );
}
