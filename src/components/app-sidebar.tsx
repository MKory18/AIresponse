"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, MessagesSquare, Users, Package, ShoppingBag, Image as ImageIcon,
  Star, BookOpen, Bot, FlaskConical, Radio, Workflow, BarChart3, Settings,
  LogOut, X, MessageSquareText,
} from "lucide-react";
import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Avatar } from "./ui/avatar";
import { ThemeToggle } from "./ui/theme-toggle";

export interface NavEntry {
  href: string;
  label: string;
  icon: string;
}

const ICONS: Record<string, React.ComponentType<LucideProps>> = {
  LayoutDashboard,
  MessagesSquare,
  Users,
  Package,
  ShoppingBag,
  Image: ImageIcon,
  Star,
  BookOpen,
  Bot,
  FlaskConical,
  Radio,
  Workflow,
  BarChart3,
  Settings,
};

export function Sidebar({
  items,
  workspaceName,
  userName,
  open,
  onClose,
}: {
  items: NavEntry[];
  workspaceName: string;
  userName: string;
  open?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);

  function navList(onNavigate?: () => void) {
    return (
      <nav aria-label={t.a11y.mainNav} className="flex-1 overflow-y-auto px-3 py-2">
        {items.map(({ href, label, icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          const Icon = ICONS[icon] ?? Bot;
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                active
                  ? "bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                  : "text-ink-muted hover:bg-surface-3 hover:text-ink"
              )}
            >
              <Icon size={17} className={cn("shrink-0", active ? "text-brand-600 dark:text-brand-400" : "text-ink-subtle")} strokeWidth={2} />
              {label}
            </Link>
          );
        })}
      </nav>
    );
  }

  const userBlock = (
    <div className="border-t border-line p-3">
      <div className="flex items-center gap-2.5 rounded-lg bg-surface-1 p-2.5">
        <Avatar name={userName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-ink">{userName}</p>
          <p className="truncate text-[10px] text-ink-subtle">{workspaceName || t.app.name}</p>
        </div>
        <form action="/api/auth/logout" method="post" onSubmit={() => setLoggingOut(true)}>
          <button
            type="submit"
            disabled={loggingOut}
            aria-label={t.common.logout}
            title={t.common.logout}
            className="rounded-lg p-1.5 text-ink-subtle transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
          >
            <LogOut size={15} />
          </button>
        </form>
      </div>
    </div>
  );

  const brand = (
    <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500 text-white shadow-xs">
        <MessageSquareText size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-ink">{t.app.name}</p>
        {workspaceName && <p className="truncate text-[11px] text-ink-muted">{workspaceName}</p>}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — RTL: start side = right */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-60 flex-col border-e border-line bg-surface-2 lg:flex">
        {brand}
        {navList()}
        <div className="mt-auto flex items-center justify-between border-t border-line px-4 py-2">
          <ThemeToggle />
        </div>
        {userBlock}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
          <div role="dialog" aria-modal="true" aria-label={t.a11y.mainNav} className="animate-fade-in absolute inset-y-0 start-0 flex w-64 max-w-[85vw] flex-col border-e border-line bg-surface-2 shadow-pop">
            <div className="flex items-center justify-between pe-2">
              <div className="flex-1">{brand}</div>
              <button onClick={onClose} aria-label={t.a11y.closeMenu} className="rounded-lg p-2 text-ink-subtle hover:bg-surface-3">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{navList(onClose)}</div>
            <div className="flex items-center justify-between px-4 py-2">
              <ThemeToggle />
            </div>
            {userBlock}
          </div>
        </div>
      )}
    </>
  );
}