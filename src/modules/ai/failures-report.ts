/**
 * تلخيص نداءات الذكاء الفاشلة (الحزمة 0.3 ـ بند 2). دالة نقية بلا قاعدة بيانات:
 * السكربت `scripts/ai-failures-report.ts` بيقرا `AIUsageLog` وبيمرّرها هون.
 * نص الخطأ بيتقصّ وبيتعتّم (أي رقم طويل ← #) — ما بنطبع بيانات زبون.
 */
export interface UsageRow {
  purpose: string;
  provider: string;
  success: boolean;
  status?: string | null;
  error?: string | null;
  latencyMs?: number | null;
}

export interface FailureGroup {
  purpose: string;
  provider: string;
  error: string;
  count: number;
  avgLatencyMs: number;
}

export interface FailureSummary {
  total: number;
  failed: number;
  failureRate: number;
  groups: FailureGroup[];
}

export function sanitizeError(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "(بلا نص خطأ)";
  return s.replace(/\d{6,}/g, "#").slice(0, 100);
}

export function summarizeFailures(rows: UsageRow[]): FailureSummary {
  const failed = rows.filter((r) => !r.success);
  const map = new Map<string, FailureGroup & { latencySum: number }>();
  for (const r of failed) {
    const error = sanitizeError(r.error ?? r.status);
    const key = `${r.purpose}|${r.provider}|${error}`;
    const g = map.get(key) ?? { purpose: r.purpose, provider: r.provider, error, count: 0, avgLatencyMs: 0, latencySum: 0 };
    g.count += 1;
    g.latencySum += r.latencyMs ?? 0;
    map.set(key, g);
  }
  const groups = [...map.values()]
    .map(({ latencySum, ...g }) => ({ ...g, avgLatencyMs: Math.round(latencySum / g.count) }))
    .sort((a, b) => b.count - a.count || a.purpose.localeCompare(b.purpose));
  return {
    total: rows.length,
    failed: failed.length,
    failureRate: rows.length === 0 ? 0 : Math.round((failed.length / rows.length) * 1000) / 10,
    groups,
  };
}
