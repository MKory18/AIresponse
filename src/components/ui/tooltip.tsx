"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * `Tooltip` — تلميحة بالمرور/التركيز (2.1) بـCSS صرف: ما بتحتاج حالة ولا مكتبة، وبتظهر بالكيبورد كمان.
 * الغلاف `group` والتلميحة `role="tooltip"` مربوطة بـ`aria-describedby`. بتنقص بـ`prefers-reduced-motion`.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content: string;
  children: React.ReactElement;
  side?: "top" | "bottom";
  className?: string;
}) {
  const id = useId();
  return (
    <span className={cn("group relative inline-flex", className)}>
      <span aria-describedby={id} className="inline-flex">
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute start-1/2 z-50 w-max max-w-60 -translate-x-1/2 rounded-control bg-ink px-2 py-1 text-xs font-medium text-surface opacity-0 shadow-overlay transition-opacity duration-100 motion-reduce:transition-none",
          "group-hover:opacity-100 group-focus-within:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        )}
      >
        {content}
      </span>
    </span>
  );
}
