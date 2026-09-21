"use client";

import { useCallback, useEffect, useState } from "react";

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
const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

const EMPTY_FORM = {
  name: "", trigger: "ORDER_CONFIRMED", province: "", minTotal: "",
  followUpTemplate: "مرحبًا {{customer.name}}، نود التأكد من أن كل شيء على ما يرام مع طلبك 🌹", delayHours: 24,
};

export default function AutomationPage() {
  const [items, setItems] = useState<Automation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/automations");
    if (res.ok) setItems((await res.json()).items);
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
    await fetch(`/api/automations/${automation.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: automation.isEnabled ? "disable" : "enable" }),
    });
    load();
  }

  async function remove(id: string) {
    await fetch(`/api/automations/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">الأتمتة</h1>
        <button onClick={() => setShowForm((s) => !s)} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
          {showForm ? "إغلاق" : "+ أتمتة جديدة"}
        </button>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {showForm && (
        <form onSubmit={create} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-2">
          <input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="اسم الأتمتة" className={input} />
          <select value={form.trigger} onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))} className={input}>
            {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={form.province} onChange={(e) => setForm((f) => ({ ...f, province: e.target.value }))} placeholder="شرط: المحافظة = (اتركه فارغًا لتجاهل الشرط)" className={input} />
          <input type="number" value={form.minTotal} onChange={(e) => setForm((f) => ({ ...f, minTotal: e.target.value }))} placeholder="شرط: إجمالي الطلب ≥" className={input} />
          <textarea value={form.followUpTemplate} onChange={(e) => setForm((f) => ({ ...f, followUpTemplate: e.target.value }))} rows={2} className={`${input} md:col-span-2`} />
          <input type="number" min="0" value={form.delayHours} onChange={(e) => setForm((f) => ({ ...f, delayHours: Number(e.target.value) }))} placeholder="الإرسال بعد (ساعات)" className={input} />
          <button disabled={creating} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {creating ? "جارٍ الإنشاء…" : "إنشاء"}
          </button>
        </form>
      )}

      <div className="space-y-2">
        {items.map((a) => {
          const last = a.executions[0];
          return (
            <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    {a.name}
                    <span className="ms-2 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700">{a.trigger}</span>
                    {!a.isEnabled && <span className="ms-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">معطلة</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {a.actions.map((ac) => ac.type).join("، ")} · أولوية {a.priority}
                    {last && <> · آخر تنفيذ: {last.status}</>}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => toggle(a)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">
                    {a.isEnabled ? "تعطيل" : "تفعيل"}
                  </button>
                  <button onClick={() => remove(a.id)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50">حذف</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {!loading_items(items) && <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">لا توجد أتمتة بعد.</p>}
    </div>
  );
}

function loading_items(items: Automation[]) {
  return items.length > 0;
}
