"use client";

import { cn } from "@/lib/cn";

/** مفتاح «شغّال» ضمن صف الجدول: مقبض بلا نص ظاهر (الاسم لقارئ الشاشة)، والحالة بالنص والأيقونة مش باللون بس. */
export function RowToggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border-strong bg-surface-3"
      )}
    >
      <span className={cn("inline-block h-4 w-4 rounded-full bg-surface-2 shadow-raised transition-transform duration-150", checked ? "-translate-x-6" : "-translate-x-1")} />
    </button>
  );
}
