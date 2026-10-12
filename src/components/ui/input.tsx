import { forwardRef } from "react";
import { cn } from "@/lib/cn";

const base =
  "w-full rounded-2xl border border-line bg-surface-3/70 px-4 text-sm text-ink placeholder:text-ink-subtle outline-none transition-all focus:border-primary focus:bg-surface-2 focus:ring-4 focus:ring-primary/10 disabled:opacity-50 dark:bg-white/[0.04]";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(base, "h-11", className)} {...props} />;
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(base, "py-2.5 leading-relaxed", className)} {...props} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return <select ref={ref} className={cn(base, "h-11 cursor-pointer", className)} {...props} />;
  }
);

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-xs font-semibold text-ink">{label}</span>
      {children}
      {error ? (
        <span className="block text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : hint ? (
        <span className="block text-[11px] leading-relaxed text-ink-subtle">{hint}</span>
      ) : null}
    </label>
  );
}
