"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Accessible modal dialog: focusable close, ESC to dismiss, overlay click closes. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div className={cn("animate-fade-in relative z-10 w-full max-w-lg rounded-xl2 border border-line bg-surface-2 shadow-pop", className)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button onClick={onClose} aria-label={t.a11y.closePanel} className="rounded-lg p-1 text-ink-subtle hover:bg-surface-3 hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/** Side drawer (used for mobile sidebar + customer panel on small screens). */
export function Drawer({
  open,
  onClose,
  side = "start",
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  side?: "start" | "end";
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "animate-fade-in absolute inset-y-0 flex w-72 max-w-[85vw] flex-col border-line bg-surface-2 shadow-pop",
          side === "start" ? "start-0 border-e" : "end-0 border-s"
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-semibold text-ink">{title}</span>
            <button onClick={onClose} aria-label={t.a11y.closePanel} className="rounded-lg p-1 text-ink-subtle hover:text-ink">
              <X size={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}