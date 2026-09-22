"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export interface TabItem {
  key: string;
  label: string;
  href?: string;
  active?: boolean;
}

export function Tabs({
  items,
  onSelect,
  activeKey,
  className,
}: {
  items: TabItem[];
  onSelect?: (key: string) => void;
  activeKey?: string;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <div role="tablist" className={cn("flex gap-1 overflow-x-auto", className)}>
      {items.map((item) => {
        const active = item.active ?? (item.href ? pathname === item.href || pathname.startsWith(item.href + "/") : item.key === activeKey);
        const cls = cn(
          "whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
          active
            ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
            : "text-ink-muted hover:bg-surface-3 hover:text-ink"
        );
        return item.href ? (
          <Link key={item.key} href={item.href} className={cls}>
            {item.label}
          </Link>
        ) : (
          <button key={item.key} onClick={() => onSelect?.(item.key)} className={cls} aria-pressed={active}>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}