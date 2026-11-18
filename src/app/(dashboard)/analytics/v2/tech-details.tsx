"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { REPORT_STRINGS as S } from "./strings";

interface Usage {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number | null;
  byModel: Array<{ key: string; calls: number; inputTokens: number; outputTokens: number }>;
}
interface Stages {
  stages: Array<{ stage: string; count: number; p50: number | null; p95: number | null }>;
  unavailable: string[];
}

const ms = (v: number | null) => (v === null ? "—" : `${formatNumber(v, 0)} ms`);

/**
 * «تفاصيل تقنية» (مطوية — للمالك والشريك): استهلاك النماذج وزمن كل مرحلة. ما بتنحمّل إلا لما تنفتح،
 * ونفس الفترة بنفس منطقة المساحة. المصدر مسارات الذكاء الموجودة (`/api/analytics/ai` · `/api/analytics/ai-stages`).
 */
export function TechDetails({ start, end, timezone }: { start: string; end: string; timezone: string }) {
  const [state, setState] = useState<{ usage: Usage; stages: Stages } | "loading" | "error" | null>(null);
  const qs = new URLSearchParams({ range: "custom", from: start, to: end, timezone }).toString();

  async function load() {
    setState("loading");
    try {
      const [usage, stages] = await Promise.all([api<Usage>(`/api/analytics/ai?${qs}`), api<Stages>(`/api/analytics/ai-stages?${qs}`)]);
      setState({ usage, stages });
    } catch {
      setState("error");
    }
  }

  return (
    <details
      data-tech
      className="rounded-card border border-line bg-surface-2"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state === null) void load();
      }}
    >
      <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-focus">
        {S.technical} <span className="ms-2 text-caption font-normal text-ink-muted">{S.technicalHint}</span>
      </summary>
      <div className="space-y-4 border-t border-line p-5">
        {state === "loading" && <Skeleton className="h-20" />}
        {state === "error" && (
          <p role="alert" className="text-sm text-danger">
            {S.loadError}
          </p>
        )}
        {state && typeof state === "object" && (
          <>
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              {[
                ["نداءات", state.usage.calls],
                ["فاشلة", state.usage.failed],
                ["رموز الإدخال", state.usage.inputTokens],
                ["رموز الإخراج", state.usage.outputTokens],
              ].map(([label, n]) => (
                <div key={String(label)}>
                  <dt className="text-caption text-ink-muted">{label}</dt>
                  <dd className="tabular-nums text-ink">{formatNumber(n, 0)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-caption text-ink-muted">متوسط زمن النداء: {ms(state.usage.avgLatencyMs)}</p>
            {state.usage.byModel.length > 0 && (
              <ul className="space-y-1 text-sm">
                {state.usage.byModel.map((m) => (
                  <li key={m.key} className="flex justify-between gap-3">
                    <span dir="ltr" className="truncate text-ink">{m.key}</span>
                    <span className="tabular-nums text-ink-muted">{formatNumber(m.calls, 0)} نداء</span>
                  </li>
                ))}
              </ul>
            )}
            {state.stages.stages.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-caption text-ink-muted">
                    <th scope="col" className="py-1 text-start font-medium">المرحلة</th>
                    <th scope="col" className="py-1 text-end font-medium">العدد</th>
                    <th scope="col" className="py-1 text-end font-medium">وسيط</th>
                    <th scope="col" className="py-1 text-end font-medium">الأبطأ 5%</th>
                  </tr>
                </thead>
                <tbody>
                  {state.stages.stages.map((s) => (
                    <tr key={s.stage} className="border-t border-line">
                      <td dir="ltr" className="py-1.5 text-start text-ink">{s.stage}</td>
                      <td className="py-1.5 text-end tabular-nums">{formatNumber(s.count, 0)}</td>
                      <td className="py-1.5 text-end tabular-nums">{ms(s.p50)}</td>
                      <td className="py-1.5 text-end tabular-nums">{ms(s.p95)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-ink-muted">
                {S.unavailable}: {state.stages.unavailable[0]?.split(": ")[1] ?? "ما في تفصيل مراحل بالفترة."}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
