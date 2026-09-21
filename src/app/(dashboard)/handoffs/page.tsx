"use client";

import { useCallback, useEffect, useState } from "react";

type Handoff = {
  id: string;
  conversationId: string;
  reason: string;
  priority: string;
  status: string;
  assignedTo: string | null;
  createdAt: string;
};

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-red-50 text-red-600",
  CLAIMED: "bg-amber-50 text-amber-700",
  RESOLVED: "bg-emerald-50 text-emerald-700",
  CANCELLED: "bg-slate-100 text-slate-500",
};
const REASONS_AR: Record<string, string> = {
  CUSTOMER_REQUEST: "العميل طلب موظفًا",
  COMPLAINT: "شكوى",
  LOW_CONFIDENCE: "ثقة AI منخفضة",
  AI_FAILURE: "فشل AI",
  ORDER_BLOCKED: "طلب محجوب بالقواعد",
  PAYMENT_ISSUE: "مشكلة دفع",
  INJECTION_DETECTED: "محاولة اختراق",
  REPEATED_FAILURE: "فشل متكرر",
  MANUAL: "يدوي",
};

export default function HandoffsPage() {
  const [items, setItems] = useState<Handoff[]>([]);
  const [status, setStatus] = useState("OPEN");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const res = await fetch(`/api/handoffs?${params}`);
    if (res.ok) setItems((await res.json()).items);
    setLoading(false);
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, action: string) {
    await fetch(`/api/handoffs/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    load();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">قائمة التحويلات للموظفين</h1>
      <div className="flex gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          {["OPEN", "CLAIMED", "RESOLVED"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      <div className="space-y-2">
        {items.map((h) => (
          <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <div>
              <p className="text-sm font-medium">
                🔴 {REASONS_AR[h.reason] ?? h.reason}
                <span className="ms-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{h.priority}</span>
              </p>
              <p className="text-xs text-slate-400">{new Date(h.createdAt).toLocaleString("ar")}{h.assignedTo ? ` · ${h.assignedTo}` : ""}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[h.status]}`}>{h.status}</span>
              {h.status === "OPEN" && (
                <button onClick={() => act(h.id, "claim")} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">استلام</button>
              )}
              {h.status === "CLAIMED" && (
                <>
                  <button onClick={() => act(h.id, "release")} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">إرجاع للقائمة</button>
                  <button onClick={() => act(h.id, "resolve")} className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50">حل</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {!loading && items.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">لا توجد تحويلات.</p>
      )}
    </div>
  );
}
