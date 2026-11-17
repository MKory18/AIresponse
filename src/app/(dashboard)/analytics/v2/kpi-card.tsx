import { Info, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Money } from "@/components/ui/formatted";
import { Tooltip } from "@/components/ui/tooltip";
import type { KpiValue } from "@/modules/analytics/kpi-catalog";
import type { KpiOut } from "@/modules/analytics/reports";
import { minutesText } from "./model";
import { REPORT_STRINGS as S } from "./strings";

/** القيمة الكبيرة حسب النوع. المبالغ سطر لكل عملة (ما بتنجمع عملتين). */
export function ValueText({ value }: { value: KpiValue }) {
  switch (value.kind) {
    case "count":
      return <>{formatNumber(value.value, 0)}</>;
    case "percent":
      return value.value === null ? <span className="text-ink-muted">{S.unavailable}</span> : <>{formatNumber(value.value, 1)}%</>;
    case "minutes":
      return value.value === null ? <span className="text-ink-muted">{S.unavailable}</span> : <>{minutesText(value.value)}</>;
    case "money":
      return value.value.length === 0 ? (
        <span className="text-ink-muted">{S.noData}</span>
      ) : (
        <span className="flex flex-col gap-0.5">
          {value.value.map((l) => (
            <Money key={l.currency} amount={l.value} currency={l.currency} />
          ))}
        </span>
      );
    default:
      return <span className="text-ink-muted">{S.unavailable}</span>;
  }
}

function subText(v: KpiValue): string | null {
  if (v.kind === "percent" && v.value !== null) return `${formatNumber(v.num, 0)} من ${formatNumber(v.den, 0)}`;
  if (v.kind === "percent") return S.noData;
  if (v.kind === "minutes" && v.value === null) return S.noData;
  if (v.kind === "minutes") return `من ${formatNumber(v.n, 0)} محادثة`;
  if (v.kind === "unavailable") return v.reason;
  return null;
}

function Delta({ k }: { k: KpiOut }) {
  if (k.delta === undefined) return null;
  if (k.delta === null) return <p className="mt-1 text-caption text-ink-subtle">{S.noBasis}</p>;
  const up = k.delta > 0;
  const down = k.delta < 0;
  const unit = k.value.kind === "percent" ? " نقطة" : k.value.kind === "minutes" ? " د" : "";
  return (
    <p data-delta className={cn("mt-1 flex items-center gap-1 text-caption", up ? "text-success" : down ? "text-danger" : "text-ink-subtle")}>
      {up && <TrendingUp size={13} aria-hidden />}
      {down && <TrendingDown size={13} aria-hidden />}
      {k.delta === 0 ? S.sameAsPrev : `${up ? "▲" : "▼"} ${formatNumber(Math.abs(k.delta), 1)}${unit} ${S.vsPrev}`}
    </p>
  );
}

/** بطاقة مؤشر: الاسم + «كيف بنحسبه» (ⓘ بمعادلة الكتالوج) + القيمة + تفصيلها + الفرق عن الفترة السابقة. قاعدة المالك: ولا رقم بلا معادلته. */
export function KpiCard({ k }: { k: KpiOut }) {
  const sub = subText(k.value);
  const note = "note" in k.value ? k.value.note : undefined;
  return (
    <div data-kpi={k.key} className="rounded-card border border-line bg-surface-2 p-5 shadow-raised">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink-muted">{k.label}</h3>
        <Tooltip content={`${S.howWeCount}: ${k.formula}`} side="bottom">
          <button type="button" aria-label={`${S.howWeCount}: ${k.label}`} className="rounded-full p-1 text-ink-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
            <Info size={14} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <p className="mt-2 text-display font-semibold tabular-nums text-ink">
        <ValueText value={k.value} />
      </p>
      {sub && <p className="mt-1 text-caption text-ink-muted">{sub}</p>}
      {note && <p className="text-caption text-ink-muted">{note}</p>}
      <Delta k={k} />
    </div>
  );
}
