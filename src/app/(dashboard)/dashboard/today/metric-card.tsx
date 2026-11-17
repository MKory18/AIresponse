import { Info, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Money } from "@/components/ui/formatted";
import { Tooltip } from "@/components/ui/tooltip";
import type { Metric } from "@/modules/today/service";
import { TODAY_STRINGS as S } from "./strings";

function valueText(m: Metric): React.ReactNode {
  if (m.value === null) return "—";
  if (m.unit === "money") return <Money amount={m.value} currency={m.currency} />;
  if (m.unit === "percent") return `${formatNumber(m.value, 1)}%`;
  return formatNumber(m.value, 0);
}

function deltaText(m: Metric): string {
  if (m.delta === null) return S.noBasis;
  const abs = Math.abs(m.delta);
  const n = m.unit === "percent" ? `${formatNumber(abs, 1)} نقطة` : m.unit === "money" ? formatNumber(abs, 2) : formatNumber(abs, 0);
  return `${n}`;
}

/**
 * بطاقة رقم: القيمة الكبيرة + الفرق عن الفترة السابقة (▲/▼ بالنص والأيقونة مش باللون بس) + «كيف بنحسبه» (ⓘ).
 * قاعدة المالك: ولا رقم بلا قاعدة احتسابه.
 */
export function MetricCard({ metric, prevLabel }: { metric: Metric; prevLabel: string }) {
  const up = (metric.delta ?? 0) > 0;
  const down = (metric.delta ?? 0) < 0;
  return (
    <div data-metric={metric.key} className="rounded-card border border-line bg-surface-2 p-5 shadow-raised">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink-muted">{metric.label}</h3>
        <Tooltip content={`${S.howWeCount}: ${metric.definition}`} side="bottom">
          <button type="button" aria-label={`${S.howWeCount}: ${metric.label}`} className="rounded-full p-1 text-ink-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
            <Info size={14} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <p className="mt-2 text-display font-semibold tabular-nums text-ink">{valueText(metric)}</p>
      <p
        data-delta
        className={cn("mt-1 flex items-center gap-1 text-caption", up ? "text-success" : down ? "text-danger" : "text-ink-subtle")}
      >
        {up && <TrendingUp size={13} aria-hidden />}
        {down && <TrendingDown size={13} aria-hidden />}
        {metric.delta === null ? (
          metric.value === null ? S.lowSample : S.noBasis
        ) : metric.delta === 0 ? (
          `مثل ${prevLabel.replace("عن ", "")}`
        ) : (
          <span>
            {up ? "▲" : "▼"} {deltaText(metric)} {prevLabel}
          </span>
        )}
      </p>
    </div>
  );
}
