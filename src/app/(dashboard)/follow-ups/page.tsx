"use client";

import { useCallback, useEffect, useState } from "react";

type FollowUp = {
  id: string;
  type: string;
  status: string;
  scheduledAt: string;
  executedAt: string | null;
  attempts: number;
  lastError: string | null;
  messageText: string | null;
};

const STATUS_STYLES: Record<string, string> = {
  SCHEDULED: "bg-amber-50 text-amber-700",
  RUNNING: "bg-blue-50 text-blue-700",
  SENT: "bg-emerald-50 text-emerald-700",
  SKIPPED: "bg-slate-100 text-slate-500",
  CANCELLED: "bg-slate-100 text-slate-500",
  FAILED: "bg-red-50 text-red-600",
};
const STATUSES = ["SCHEDULED", "SENT", "FAILED", "CANCELLED", "SKIPPED", "RUNNING"];

export default function FollowUpsPage() {
  const [items, setItems] = useState<FollowUp[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const res = await fetch(`/api/follow-ups?${params}`);
    if (res.ok) setItems((await res.json()).items);
    setLoading(false);
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function cancel(id: string) {
    await fetch(`/api/follow-ups/${id}/cancel`, { method: "POST" });
    load();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">المتابعات</h1>
      <div className="flex gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل الحالات</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      <div className="space-y-2">
        {items.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-slate-700">{f.messageText ?? f.type}</p>
              <p className="text-xs text-slate-400">
                مجدولة: {new Date(f.scheduledAt).toLocaleString("ar")} · محاولات: {f.attempts}
                {f.lastError && <> · {f.lastError}</>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[f.status]}`}>{f.status}</span>
              {f.status === "SCHEDULED" && (
                <button onClick={() => cancel(f.id)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50">إلغاء</button>
              )}
            </div>
          </div>
        ))}
      </div>
      {!loading && items.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">لا توجد متابعات.</p>
      )}
    </div>
  );
}
