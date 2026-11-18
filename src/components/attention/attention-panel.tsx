"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import type { AttentionItem, Severity } from "@/modules/attention/service";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { DateTime } from "@/components/ui/formatted";
import { useAttention } from "./use-attention";

const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
  critical: { label: "عطل", tone: "danger" },
  high: { label: "مهم", tone: "warning" },
  medium: { label: "انتبه", tone: "info" },
  low: { label: "لاحقًا", tone: "neutral" },
};

/** لوحة «يحتاجك» — نفس بنود «اليوم ← يحتاجك الآن». كل بند رابط مباشر لمكان المعالجة (نقرة وحدة). */
export function AttentionPanelView({ items, onNavigate }: { items: readonly AttentionItem[]; onNavigate?: () => void }) {
  if (items.length === 0) {
    return (
      <div data-attention-empty className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <CheckCircle2 size={28} className="text-success" aria-hidden />
        <p className="text-sm font-medium text-ink">ما في شي يحتاجك هلأ</p>
        <p className="text-caption text-ink-muted">لما يصير شي بدّه تدخّل بيظهر هون.</p>
      </div>
    );
  }
  return (
    <ul data-attention-list className="divide-y divide-line">
      {items.map((i) => (
        <li key={i.id}>
          <Link
            href={i.href}
            onClick={onNavigate}
            data-attention-item={i.type}
            className="flex items-start gap-3 px-4 py-3 transition-colors duration-100 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <StatusChip tone={SEVERITY[i.severity].tone} className="mt-0.5 shrink-0">
              {SEVERITY[i.severity].label}
            </StatusChip>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{i.title}</span>
              <span className="block truncate text-caption text-ink-muted">{i.subtitle}</span>
            </span>
            <DateTime value={i.createdAt} mode="relative" className="shrink-0 text-caption text-ink-subtle" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function AttentionPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { data, loaded } = useAttention();
  if (!loaded) return <div className="px-4 py-6 text-caption text-ink-muted">جاري التحميل…</div>;
  return <AttentionPanelView items={data.items} onNavigate={onNavigate} />;
}
