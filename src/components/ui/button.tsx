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
    "bg-brand-500 text-white shadow-xs hover:bg-brand-600 active:bg-brand-700 disabled:bg-brand-300",
  secondary:
    "border border-line bg-surface-2 text-ink hover:bg-surface-3 active:bg-surface-3 disabled:opacity-50",
  ghost: "text-ink-muted hover:bg-surface-3 hover:text-ink disabled:opacity-50",
  danger: "border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50",
  success: "bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50",
};

const sizes: Record<Size, string> = {
  sm: "h-7 gap-1 rounded-lg px-2.5 text-xs",
  md: "h-9 gap-1.5 rounded-lg px-3.5 text-sm",
  lg: "h-11 gap-2 rounded-xl px-5 text-sm",
  icon: "h-8 w-8 rounded-lg",
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
        "inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors duration-150 focus-visible:outline-2 disabled:cursor-not-allowed",
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