"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

/**
 * `IconButton` — زر بأيقونة بس (2.1، §3.3): `aria-label` **إلزامي** (وبيطلع كتلميحة)، وهدف لمس ≥ 40px.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { "aria-label": string; tone?: "neutral" | "danger" }
>(function IconButton({ className, tone = "neutral", children, ...props }, ref) {
  return (
    <Tooltip content={props["aria-label"]}>
      <button
        ref={ref}
        type="button"
        className={cn(
          "inline-flex h-10 w-10 items-center justify-center rounded-control transition-colors duration-150 ease-zaki focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
          tone === "danger" ? "text-danger hover:bg-danger-soft" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
          className
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});
