"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Accessible modal dialog: focus trap + restore, ESC to dismiss, overlay click closes. */
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
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    // Focus trap: keep Tab inside the dialog, restore focus on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => !el.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", trap);
      document.body.style.overflow = "";
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div ref={panelRef} className={cn("glass-strong animate-scale-in relative z-10 max-h-[85vh] w-full max-w-lg overflow-hidden rounded-2xl", className)}>
        <div className="flex items-center justify-between border-b border-line/70 px-5 py-3.5">
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          <button onClick={onClose} aria-label={t.a11y.closePanel} className="rounded-lg p-1.5 text-ink-subtle transition hover:bg-surface-3 hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/** Side drawer (mobile sidebar + customer panel on small screens). */
export function Drawer({
  open,
  onClose,
  side = "start",
  title,
  children,
  className,
  until = "lg",
}: {
  open: boolean;
  onClose: () => void;
  side?: "start" | "end";
  title?: string;
  children: React.ReactNode;
  className?: string;
  /** Hidden at this breakpoint and up (defaults to lg). */
  until?: "lg" | "xl";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={cn("fixed inset-0 z-50", until === "xl" ? "xl:hidden" : "lg:hidden")}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "glass-strong animate-slide-in absolute inset-y-0 flex w-80 max-w-[88vw] flex-col",
          side === "start" ? "start-0 border-e" : "end-0 border-s"
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
            <span className="text-sm font-bold text-ink">{title}</span>
            <button onClick={onClose} aria-label={t.a11y.closePanel} className="rounded-lg p-1.5 text-ink-subtle transition hover:text-ink">
              <X size={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
