"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-gradient-to-b from-brand-400 to-brand-600 text-white shadow-[0_1px_2px_rgb(29_85_209/0.4),inset_0_1px_0_rgb(255_255_255/0.25)] hover:brightness-110 active:brightness-95 disabled:opacity-50 disabled:saturate-50",
  secondary:
    "glass-subtle text-ink hover:border-brand-300 hover:text-brand-700 active:scale-[0.98] disabled:opacity-50 dark:hover:text-brand-300",
  ghost: "text-ink-muted hover:bg-surface-3 hover:text-ink active:scale-[0.98] disabled:opacity-50",
  danger:
    "border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 active:scale-[0.98] disabled:opacity-50 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  success:
    "bg-gradient-to-b from-emerald-500 to-emerald-600 text-white shadow-xs hover:brightness-110 active:brightness-95 disabled:opacity-50",
};

const sizes: Record<Size, string> = {
  sm: "h-7 gap-1 rounded-lg px-2.5 text-xs",
  md: "h-9 gap-1.5 rounded-xl px-3.5 text-[13px]",
  lg: "h-11 gap-2 rounded-xl px-5 text-sm",
  icon: "h-8 w-8 rounded-xl",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading, disabled, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap rounded-xl font-semibold transition-all duration-150 focus-visible:outline-2 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {loading && (
        <span aria-hidden className="me-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
});
