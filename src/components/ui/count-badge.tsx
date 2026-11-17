import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";

/**
 * `CountBadge` — عدّاد القائمة والتبويبات (2.1). صفر بيختفي افتراضيًا (`showZero` لإظهاره)، وفوق `max` بيصير «99+».
 * `tone="danger"` للي بيحتاج انتباه (يحتاجك)، و`neutral` للعدّ العادي.
 */
export function CountBadge({
  count,
  max = 99,
  tone = "neutral",
  showZero = false,
  className,
}: {
  count: number;
  max?: number;
  tone?: "neutral" | "danger";
  showZero?: boolean;
  className?: string;
}) {
  if (!Number.isFinite(count) || count < 0 || (count === 0 && !showZero)) return null;
  return (
    <span
      data-count-badge
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums",
        tone === "danger" ? "bg-danger text-on-primary" : "bg-surface-3 text-ink-muted",
        className
      )}
    >
      {count > max ? `${formatNumber(max, 0)}+` : formatNumber(count, 0)}
    </span>
  );
}
