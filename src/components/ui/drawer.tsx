"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "./icon-button";

/**
 * `Drawer` — درج التفاصيل (2.1/3.2): يفتح من اليسار بالـRTL بعرض 480px، وبالجوال ملء الشاشة.
 * `role="dialog"` + `aria-modal` · Esc أو النقر على الخلفية بيسكّر · التركيز بيروح للدرج وبيرجع للعنصر السابق.
 * الرابط الدائم (`?order=<id>`) مسؤولية المستدعي.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" data-drawer>
      <button type="button" aria-label="إغلاق" tabIndex={-1} className="absolute inset-0 cursor-default bg-ink/40" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "absolute inset-y-0 left-0 flex w-full flex-col bg-surface-2 shadow-overlay outline-none sm:w-[480px] sm:rounded-s-sheet",
          className
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="min-w-0 truncate text-base font-semibold text-ink">{title}</h2>
          <IconButton aria-label="إغلاق" onClick={onClose}>
            <X size={18} aria-hidden />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
