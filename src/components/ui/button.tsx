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
    "bg-primary text-white hover:bg-primary-hover active:bg-primary-hover disabled:opacity-50",
  secondary:
    "border border-line bg-surface-2 text-ink hover:bg-surface-hover active:bg-surface-3 disabled:opacity-50",
  ghost: "text-ink hover:bg-surface-hover active:bg-surface-3 disabled:opacity-50",
  danger:
    "border border-red-300/70 bg-surface-2 text-red-700 hover:bg-red-50 active:bg-red-100 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40",
  success:
    "bg-[#107c10] text-white hover:bg-[#0b6a0b] active:bg-[#0b6a0b] disabled:opacity-50",
};

const sizes: Record<Size, string> = {
  sm: "h-8 gap-1 rounded-lg px-2.5 text-xs",
  md: "h-9 gap-1.5 rounded-lg px-3.5 text-sm",
  lg: "h-10 gap-2 rounded-lg px-4 text-sm",
  icon: "h-9 w-9 rounded-lg",
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
        "inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed",
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
