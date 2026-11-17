"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

/**
 * `SegmentedControl` — اختيار من 2–4 خيارات بشكل واحد (2.1). `radiogroup` بأسهم الكيبورد،
 * والمختار بيتميّز بتعبئة وخط (مش باللون بس).
 */
export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: V;
  onChange: (next: V) => void;
  options: readonly SegmentOption<V>[];
  /** اسم المجموعة لقارئ الشاشة. */
  label: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: React.KeyboardEvent, index: number) {
    const dir = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0; // RTL: يسار = التالي
    if (!dir) return;
    e.preventDefault();
    const next = (index + dir + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-control border border-border-strong bg-surface-3 p-0.5", className)}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "min-h-8 rounded-[5px] px-3 text-sm font-medium transition-colors duration-150 ease-zaki focus-visible:outline-2 focus-visible:outline-focus",
              active ? "bg-primary text-on-primary shadow-raised" : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
