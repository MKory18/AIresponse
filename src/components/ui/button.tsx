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
    "bg-primary text-white shadow-[0_8px_20px_-10px_rgb(64_88_243/0.7)] hover:bg-primary-hover active:bg-primary-hover disabled:opacity-50",
  secondary:
    "border border-line bg-surface-2 text-ink-muted hover:bg-surface-hover hover:text-ink active:scale-[0.98] disabled:opacity-50 dark:hover:text-brand-300",
  ghost: "text-ink-muted hover:bg-surface-3 hover:text-ink active:scale-[0.98] disabled:opacity-50",
  danger:
    "border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 active:scale-[0.98] disabled:opacity-50 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  success:
    "bg-emerald-600 text-white shadow-xs hover:brightness-105 active:brightness-95 disabled:opacity-50",
};

const sizes: Record<Size, string> = {
  sm: "h-8 gap-1 rounded-xl px-3 text-xs",
  md: "h-11 gap-1.5 rounded-2xl px-4 text-sm",
  lg: "h-12 gap-2 rounded-2xl px-5 text-sm",
  icon: "h-10 w-10 rounded-2xl",
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
        "inline-flex select-none items-center justify-center whitespace-nowrap rounded-2xl font-semibold transition-all duration-150 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed",
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
