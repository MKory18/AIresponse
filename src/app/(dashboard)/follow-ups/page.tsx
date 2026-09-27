"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

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
    <div className="page-wrap">
      <PageHeader title={t.pages.followupsTitle} description={t.pages.followupsDesc} />

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.common.status} className="w-44">
          <option value="">{t.common.all} — الحالات</option>
          {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </Select>
      </GlassCard>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
        </div>
      )}
      {!loading && (
        <div className="space-y-2.5">
          {items.map((f) => (
            <GlassCard key={f.id} className="flex flex-wrap items-center justify-between gap-3 p-4 transition-all hover:shadow-glass">
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-sm font-bold text-ink">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
                    <Clock size={14} />
                  </span>
                  <span className="truncate">{f.messageText ?? label(f.type)}</span>
                </p>
                <p className="num mt-1 text-xs text-ink-muted">
                  مجدولة: {new Date(f.scheduledAt).toLocaleString("ar")} · محاولات: {f.attempts}
                  {f.lastError && <> · {f.lastError}</>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge value={f.status} dot />
                {f.status === "SCHEDULED" && (
                  <Button size="sm" variant="ghost" onClick={() => cancel(f.id)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">{t.common.cancel}</Button>
                )}
              </div>
            </GlassCard>
          ))}
        </div>
      )}
      {!loading && items.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<Clock size={28} strokeWidth={1.5} />}
            title="لا توجد متابعات"
            description="ستظهر هنا الرسائل المجدولة لعملائك."
          />
        </GlassCard>
      )}
    </div>
  );
}
