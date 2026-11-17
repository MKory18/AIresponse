import { formatDate, formatDateTime, formatMoney, formatNumber, formatRelative, formatTime } from "@/lib/format";

/**
 * `Money` · `DateTime` · `Num` (2.1): غلاف رفيع على `lib/format.ts` — تنسيق واحد بكل الواجهة.
 * الأرقام لاتينية و`tabular-nums` (ما بتتراقص الأعمدة)، والتاريخ بتوقيت المساحة، و`<time>` بقيمة قابلة للقراءة آليًا.
 */
export function Money({ amount, currency, className }: { amount: unknown; currency: string | null | undefined; className?: string }) {
  return (
    <span dir="ltr" className={`tabular-nums ${className ?? ""}`.trim()}>
      {formatMoney(amount, currency)}
    </span>
  );
}

export function Num({ value, maxFraction = 0, className }: { value: unknown; maxFraction?: number; className?: string }) {
  return <span className={`tabular-nums ${className ?? ""}`.trim()}>{formatNumber(value, maxFraction)}</span>;
}

export function DateTime({
  value,
  timeZone,
  mode = "datetime",
  now,
  className,
}: {
  value: string | Date | null | undefined;
  /** توقيت المساحة (`Workspace.timezone`). */
  timeZone?: string | null;
  mode?: "datetime" | "date" | "time" | "relative";
  now?: Date;
  className?: string;
}) {
  const text =
    mode === "date"
      ? formatDate(value, timeZone, now)
      : mode === "time"
        ? formatTime(value, timeZone)
        : mode === "relative"
          ? formatRelative(value, now, timeZone)
          : formatDateTime(value, timeZone);
  const iso = value ? new Date(value).toISOString() : undefined;
  return (
    <time dateTime={Number.isNaN(Date.parse(String(value))) ? undefined : iso} className={`tabular-nums ${className ?? ""}`.trim()}>
      {text}
    </time>
  );
}
