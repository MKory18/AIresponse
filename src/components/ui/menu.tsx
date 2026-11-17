"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "./icon-button";

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  /** الخطِر (حذف · إلغاء طلب · فصل صفحة): بيتفصل تحت خط، ودايمًا بحوار تأكيد عند المستدعي. */
  danger?: boolean;
  disabled?: boolean;
}

/**
 * `Menu` — قائمة «⋯» (2.1). الخطِر ما بيقعد جنب الأساسي أبدًا (§3.3): بيطلع آخر القائمة تحت فاصل.
 * كيبورد: Enter/Space بتفتح · ↑↓ بتنقّل · Esc بتسكّر وبترجّع التركيز · نقرة برّا بتسكّر.
 */
export function Menu({ items, label = "المزيد", className }: { items: readonly MenuItem[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const normal = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);
  const ordered = [...normal, ...danger];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = els.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length;
    els[next]?.focus();
  }

  function item(i: MenuItem) {
    return (
      <button
        key={i.key}
        type="button"
        role="menuitem"
        disabled={i.disabled}
        onClick={() => {
          setOpen(false);
          i.onSelect();
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
          i.danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-surface-hover"
        )}
      >
        {i.icon}
        {i.label}
      </button>
    );
  }

  return (
    <div ref={root} className={cn("relative inline-block", className)} onKeyDown={onKey}>
      <IconButton ref={trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={18} aria-hidden />
      </IconButton>
      {open && (
        <div role="menu" aria-label={label} className="absolute end-0 top-full z-50 mt-1 min-w-44 rounded-card border border-line bg-surface-2 p-1 shadow-overlay">
          {normal.map(item)}
          {danger.length > 0 && normal.length > 0 && <div role="separator" className="my-1 h-px bg-line" />}
          {danger.map(item)}
          {ordered.length === 0 && <p className="px-3 py-2 text-caption text-ink-subtle">لا خيارات</p>}
        </div>
      )}
    </div>
  );
}
