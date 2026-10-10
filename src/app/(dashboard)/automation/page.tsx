"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Power, Trash2, Workflow, Zap } from "lucide-react";
import { t, label as enumLabel } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Automation = {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  conditions: { all?: { field: string; operator: string; value?: string | number }[] };
  actions: { type: string; template?: string; delayHours?: number; tag?: string; title?: string }[];
  priority: number;
  isEnabled: boolean;
  executions: { id: string; status: string; startedAt: string }[];
};

const TRIGGERS = [
  "ORDER_CREATED", "ORDER_CONFIRMED", "ORDER_CANCELLED", "ORDER_DELIVERED",
  "CONVERSATION_CREATED", "CUSTOMER_CREATED",
];

const EMPTY_FORM = {
  name: "", trigger: "ORDER_CONFIRMED", province: "", minTotal: "",
  followUpTemplate: "مرحبًا {{customer.name}}، نود التأكد من أن كل شيء على ما يرام مع طلبك.", delayHours: 24,
};

export default function AutomationPage() {
  const [items, setItems] = useState<Automation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/automations");
      if (!res.ok) throw new Error();
      setItems((await res.json()).items);
      setError(null);
    } catch {
      setError("تعذّر تحميل الأتمتة");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    const conditions: Automation["conditions"] = {};
    const all: { field: string; operator: "EQ" | "GTE"; value?: string | number }[] = [];
    if (form.province) all.push({ field: "customer.province", operator: "EQ", value: form.province });
    if (form.minTotal) all.push({ field: "order.total", operator: "GTE", value: Number(form.minTotal) });
    if (all.length) conditions.all = all;

    const res = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        trigger: form.trigger,
        conditions,
        actions: [{ type: "CREATE_FOLLOW_UP", template: form.followUpTemplate, delayHours: Number(form.delayHours), followUpType: "CHECK_IN" }],
        priority: 0,
        isEnabled: true,
      }),
    });
    setCreating(false);
    if (res.ok) {
      setShowForm(false);
      setForm(EMPTY_FORM);
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل الإنشاء");
    }
  }

  async function toggle(automation: Automation) {
    setBusy(`toggle:${automation.id}`);
    try {
      const res = await fetch(`/api/automations/${automation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: automation.isEnabled ? "disable" : "enable" }),
      });
      if (!res.ok) throw new Error();
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
      load();
    }
  }

  async function remove(id: string) {
    setBusy(`delete:${id}`);
    try {
      const res = await fetch(`/api/automations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setDeleteTarget(null);
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
      load();
    }
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title={t.pages.automationTitle}
        description={t.pages.automationDesc}
        actions={
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus size={14} /> أتمتة جديدة
          </Button>
        }
      />
      {error && (
        <GlassCard level="glass-subtle" className="border-red-500/20 px-4 py-2.5 text-sm text-red-600 dark:text-red-400">{error}</GlassCard>
      )}

      {loading && (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      )}

      {!loading && error && items.length === 0 && (
        <GlassCard>
          <ErrorState onRetry={load} />
        </GlassCard>
      )}

      {!loading && !error && (
        <div className="space-y-2.5">
          {items.map((a) => {
            const last = a.executions[0];
            return (
              <GlassCard key={a.id} className="p-4 transition-all hover:shadow-glass">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${a.isEnabled ? "bg-gradient-to-br from-violet-500/20 to-brand-500/20 text-brand-600 dark:text-brand-300" : "bg-surface-3 text-ink-subtle"}`}>
                      <Workflow size={17} />
                    </span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
                        {a.name}
                        <Badge tone="AI_ACTIVE">{enumLabel(a.trigger)}</Badge>
                        {!a.isEnabled && <Badge tone="CLOSED">معطلة</Badge>}
                      </p>
                      <p className="num mt-1 text-xs text-ink-muted">
                        {a.actions.map((ac) => enumLabel(ac.type)).join("، ")} · أولوية {a.priority}
                        {last && <> · آخر تنفيذ: {enumLabel(last.status)}</>}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => toggle(a)} disabled={busy !== null} loading={busy === `toggle:${a.id}`}>
                      <Power size={13} />
                      {a.isEnabled ? "تعطيل" : "تفعيل"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(a)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
                      <Trash2 size={13} />
                      {t.common.delete}
                    </Button>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<Zap size={28} strokeWidth={1.5} />}
            title="لا توجد أتمتة بعد"
            description="أنشئ أول قاعدة تلقائية لمتابعة الطلبات والعملاء."
            action={<Button size="sm" onClick={() => setShowForm(true)}><Plus size={14} /> أتمتة جديدة</Button>}
          />
        </GlassCard>
      )}

      <Dialog open={showForm} onClose={() => setShowForm(false)} title="أتمتة جديدة">
        <form onSubmit={create} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="اسم الأتمتة">
            <Input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="مثال: متابعة بعد التأكيد" />
          </Field>
          <Field label="الحدث المشغّل">
            <Select value={form.trigger} onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}>
              {TRIGGERS.map((trigger) => <option key={trigger} value={trigger}>{enumLabel(trigger)}</option>)}
            </Select>
          </Field>
          <Field label="شرط المحافظة" hint="اتركه فارغًا لتجاهل الشرط.">
            <Input value={form.province} onChange={(e) => setForm((f) => ({ ...f, province: e.target.value }))} placeholder="مثال: دمشق" />
          </Field>
          <Field label="شرط إجمالي الطلب">
            <Input type="number" value={form.minTotal} onChange={(e) => setForm((f) => ({ ...f, minTotal: e.target.value }))} placeholder="≥" dir="ltr" className="num" />
          </Field>
          <Field label="نص رسالة المتابعة" className="sm:col-span-2">
            <Textarea value={form.followUpTemplate} onChange={(e) => setForm((f) => ({ ...f, followUpTemplate: e.target.value }))} rows={2} />
          </Field>
          <Field label="الإرسال بعد (ساعات)">
            <Input type="number" min="0" value={form.delayHours} onChange={(e) => setForm((f) => ({ ...f, delayHours: Number(e.target.value) }))} dir="ltr" className="num" />
          </Field>
          <div className="flex items-end justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={creating}>إنشاء</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void remove(deleteTarget.id)}
        title={`حذف الأتمتة "${deleteTarget?.name ?? ""}"؟`}
        body="لن تُنفَّذ هذه القاعدة التلقائية بعد الآن. سجل التنفيذ السابق يبقى محفوظًا."
        confirmLabel="حذف نهائي"
        busy={busy === `delete:${deleteTarget?.id}`}
        danger
      />
    </div>
  );
}
