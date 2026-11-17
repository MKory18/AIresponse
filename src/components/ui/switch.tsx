"use client";

import { cn } from "@/lib/cn";

/**
 * `Switch` — الطريقة الوحيدة لـ«شغّال/متوقف» (2.1). بدل مربع/حبة/زر/رابط/قائمة.
 * الاسم ظاهر دايمًا (`label`)، والحالة مقروءة بالنص مش باللون بس. RTL: المقبض بيروح لجهة اليمين لما يكون شغّال.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  busy,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const off = disabled || busy;
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && <span className="block text-caption text-ink-muted">{description}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className={cn("text-xs font-medium", checked ? "text-success" : "text-ink-subtle")} aria-hidden>
          {checked ? "شغّال" : "متوقف"}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={off}
          onClick={() => onChange(!checked)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150 ease-zaki focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
            checked ? "border-primary bg-primary" : "border-border-strong bg-surface-3"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block h-4 w-4 rounded-full shadow-raised transition-transform duration-150 ease-zaki",
              checked ? "bg-on-primary ltr:translate-x-6 rtl:-translate-x-6" : "bg-ink-muted ltr:translate-x-1 rtl:-translate-x-1"
            )}
          />
        </button>
      </span>
    </div>
  );
}
