"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Hand } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Handoff = {
  id: string;
  conversationId: string;
  reason: string;
  priority: string;
  status: string;
  assignedTo: string | null;
  createdAt: string;
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
    <div className="page-wrap">
      <PageHeader title={t.pages.handoffsTitle} description={t.pages.handoffsDesc} />

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.common.status} className="w-44">
          {["OPEN", "CLAIMED", "RESOLVED"].map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </Select>
      </GlassCard>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
        </div>
      )}
      {!loading && (
        <div className="space-y-2.5">
          {items.map((h) => (
            <GlassCard key={h.id} className="flex flex-wrap items-center justify-between gap-3 p-4 transition-all hover:shadow-glass">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-ink">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
                    <Hand size={14} />
                  </span>
                  {REASONS_AR[h.reason] ?? h.reason}
                  <StatusBadge value={h.priority} />
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  {new Date(h.createdAt).toLocaleString("ar")}{h.assignedTo ? ` · ${h.assignedTo}` : ""}
                  {" · "}
                  <Link href={`/conversations`} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">فتح المحادثة</Link>
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusBadge value={h.status} dot />
                {h.status === "OPEN" && (
                  <Button size="sm" variant="secondary" onClick={() => act(h.id, "claim")}>استلام</Button>
                )}
                {h.status === "CLAIMED" && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => act(h.id, "release")}>إرجاع للقائمة</Button>
                    <Button size="sm" variant="success" onClick={() => act(h.id, "resolve")}>حل</Button>
                  </>
                )}
              </div>
            </GlassCard>
          ))}
        </div>
      )}
      {!loading && items.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<Hand size={28} strokeWidth={1.5} />}
            title="لا توجد تحويلات"
            description="ستظهر هنا المحادثات التي تحتاج تدخلًا بشريًا."
          />
        </GlassCard>
      )}
    </div>
  );
}
