"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { HealthPill, SectionHead, apiJson, fmtDateTime, type Health } from "./ui";

interface DeliveryView {
  id: string;
  system: string;
  kind: string;
  type: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
}

const STATUS: Record<string, { health: Health; label: string }> = {
  OK: { health: "ok", label: "وصل" },
  PENDING: { health: "warn", label: "بالانتظار" },
  SENDING: { health: "warn", label: "عم ينبعت" },
  FAILED: { health: "error", label: "فشل" },
  CANCELLED: { health: "off", label: "ملغى" },
};

const TYPE_AR: Record<string, string> = {
  "conversation.coded": "محادثة برمز",
  "retarget.result": "نتيجة حملة",
  opt_out: "إلغاء اشتراك",
  "capacity.alert": "إنذار القدرة",
  "usage-costs": "تكاليف اليوم",
  alerts: "إنذار أزمات",
  tasks: "مهمة",
  ideas: "فكرة",
};

export function DeliveriesLog({ systems, focusSystem, refreshKey }: { systems: Array<{ key: string; nameAr: string }>; focusSystem: string; refreshKey: number }) {
  const toast = useToast();
  const [system, setSystem] = useState(focusSystem);
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<DeliveryView[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => setSystem(focusSystem), [focusSystem]);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ limit: "50", ...(system ? { system } : {}), ...(status ? { status } : {}) });
    try {
      setRows(await apiJson<DeliveryView[]>(`/api/integrations/deliveries?${q.toString()}`));
    } catch {
      setRows([]);
    }
  }, [system, status]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function retry(id: string) {
    setBusyId(id);
    try {
      await apiJson(`/api/integrations/deliveries/${id}/retry`, { method: "POST" });
      toast.show("رجعت للطابور — العامل بيبعتها بالدورة الجاية");
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل", "error");
    } finally {
      setBusyId(null);
    }
  }

  const nameOf = (k: string) => systems.find((s) => s.key === k)?.nameAr ?? k;
  return (
    <GlassCard id="deliveries" className="space-y-3 p-4 sm:p-5">
      <SectionHead icon={<History size={15} />} title="سجل الصادر" sub="كل حدث أو نداء لنظام تاني: لمين · شو · كم محاولة · شو رجع — بلا نص الرسالة." tone="slate" />
      <div className="grid grid-cols-2 gap-2 sm:max-w-md">
        <Select value={system} onChange={(e) => setSystem(e.target.value)} aria-label="النظام">
          <option value="">كل الأنظمة</option>
          {systems.map((s) => (
            <option key={s.key} value={s.key}>
              {s.nameAr}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
          <option value="">كل الحالات</option>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      {rows === null ? (
        <p className="text-xs text-ink-subtle">جارٍ التحميل…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-ink-subtle">ما في شي هون.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((r) => {
            const st = STATUS[r.status] ?? { health: "off" as Health, label: r.status };
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
                    {TYPE_AR[r.type] ?? r.type}
                    <span className="font-normal text-ink-muted">← {nameOf(r.system)}</span>
                    <HealthPill health={st.health}>{st.label}</HealthPill>
                  </p>
                  <p className="text-[11px] text-ink-subtle">
                    {fmtDateTime(r.createdAt)} · محاولات {r.attempts}
                    {r.responseCode ? ` · رد ${r.responseCode}` : ""}
                    {r.error ? ` · ${r.error}` : ""}
                    {r.status === "PENDING" && r.nextAttemptAt ? ` · المحاولة الجاية ${fmtDateTime(r.nextAttemptAt)}` : ""}
                  </p>
                </div>
                {(r.status === "FAILED" || r.status === "CANCELLED") && (
                  <Button size="sm" variant="secondary" onClick={() => retry(r.id)} loading={busyId === r.id} disabled={busyId !== null}>
                    <RotateCcw size={12} />
                    أعد المحاولة
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}
