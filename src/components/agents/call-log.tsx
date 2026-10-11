"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { GlassCard } from "@/components/ui/card";
import { HealthPill, SectionHead, apiJson, fmtDateTime, type Health } from "@/components/integrations/ui";

interface CallRow {
  id: string;
  tool: string;
  risk: string;
  status: string;
  errorCode: string | null;
  agentRef: string | null;
  dryRun: boolean;
  latencyMs: number;
  createdAt: string;
}

const TOOL_AR: Record<string, string> = {
  get_inbox_summary: "ملخص الصندوق",
  get_sales_funnel: "قمع البيع",
  get_capacity_status: "قدرة الرد",
  get_top_questions: "أكثر الأسئلة",
  get_team_performance: "أداء الفريق",
  list_templates: "القوالب",
  draft_reply_template: "مسودة قالب رد",
  draft_retarget_campaign: "مسودة حملة",
  get_status_summary: "حالة النظام",
  list_owner_queue: "بانتظار المالك",
  get_draft_status: "حالة المسودات",
};

const STATUS: Record<string, { health: Health; label: string }> = {
  ok: { health: "ok", label: "تمام" },
  draft_created: { health: "ok", label: "مسودة" },
  draft_replayed: { health: "ok", label: "نفس المسودة" },
  dry_run: { health: "off", label: "تجربة" },
  error: { health: "error", label: "مرفوض" },
};

export function CallLog({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<{ calls: CallRow[]; today: { total: number; errors: number; drafts: number } } | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await apiJson("/api/agent-calls"));
    } catch {
      setData({ calls: [], today: { total: 0, errors: 0, drafts: 0 } });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <GlassCard className="space-y-3 p-4 sm:p-5">
      <SectionHead icon={<Activity size={15} />} title="سجل النداءات" sub="مين · أي أداة · النتيجة · الوقت — بلا أي مدخلات أو أرقام زبائن." tone="slate" />
      {data && (
        <div className="flex flex-wrap gap-2">
          <HealthPill health="ok">اليوم {data.today.total} نداء</HealthPill>
          <HealthPill health={data.today.errors ? "error" : "off"}>{data.today.errors} مرفوض</HealthPill>
          <HealthPill health="off">{data.today.drafts} مسودة</HealthPill>
        </div>
      )}
      {!data ? (
        <p className="text-xs text-ink-subtle">جارٍ التحميل…</p>
      ) : data.calls.length === 0 ? (
        <p className="text-xs text-ink-subtle">ما وصل ولا نداء لسا. بعد ربط الجسر، أول نداء بيبين هون.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {data.calls.map((c) => {
            const st = STATUS[c.status] ?? { health: "off" as Health, label: c.status };
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span className="min-w-0">
                  <span className="font-semibold text-ink">{TOOL_AR[c.tool] ?? c.tool}</span>
                  <span className="text-ink-subtle">
                    {" "}
                    · {fmtDateTime(c.createdAt)} · <span className="num">{c.latencyMs}</span>ms{c.agentRef ? ` · ${c.agentRef}` : ""}
                    {c.errorCode ? ` · ${c.errorCode}` : ""}
                  </span>
                </span>
                <HealthPill health={st.health}>{c.dryRun ? "تجربة" : st.label}</HealthPill>
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}
