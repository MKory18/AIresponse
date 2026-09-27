"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, MessageSquare, Users, Package, ShoppingBag, Images,
  MessageCircle, BookOpen, UserRound, FlaskConical, Radio, Workflow, Clock,
  Hand, ChartNoAxesCombined, Settings, LogOut, X, MessageSquareText,
  ChevronsRight, ChevronsLeft, Bell,
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
  badge?: string;
}

const ICONS: Record<string, React.ComponentType<LucideProps>> = {
  LayoutDashboard,
  MessageSquare,
  MessagesSquare: MessageSquare,
  Users,
  Package,
  ShoppingBag,
  Image: Images,
  Images,
  Star: MessageCircle,
  MessageCircle,
  BookOpen,
  Bot: UserRound,
  UserRound,
  FlaskConical,
  Radio,
  Workflow,
  Clock,
  Hand,
  BarChart3: ChartNoAxesCombined,
  ChartNoAxesCombined,
  Settings,
};

function NavLink({
  href,
  label,
  icon,
  badge,
  active,
  collapsed,
  onNavigate,
}: NavEntry & { active: boolean; collapsed?: boolean; onNavigate?: () => void }) {
  const Icon = ICONS[icon] ?? MessageSquare;
  return (
    <Link
      key={href}
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "group relative mb-0.5 flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-all duration-150",
        active
          ? "bg-gradient-to-l from-brand-500/15 to-brand-500/5 font-semibold text-brand-700 shadow-glow dark:text-brand-300"
          : "text-ink-muted hover:bg-surface-3/80 hover:text-ink",
        collapsed && "justify-center px-0"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1.5 start-0 w-1 rounded-full bg-gradient-to-b from-brand-400 to-brand-600 transition-all",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-30"
        )}
      />
      <Icon
        size={18}
        strokeWidth={active ? 2.25 : 2}
        className={cn(
          "shrink-0 transition-colors",
          active ? "text-brand-600 dark:text-brand-400" : "text-ink-subtle group-hover:text-ink-muted"
        )}
      />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge && (
        <span className="num flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">
          {badge}
        </span>
      )}
    </Link>
  );
}

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
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const c = localStorage.getItem("sidebar-collapsed") === "1";
      setCollapsed(c);
      document.documentElement.dataset.sidebar = c ? "collapsed" : "expanded";
    } catch { /* ignore */ }
  }, []);

  function toggleCollapse() {
    setCollapsed((c) => {
      try {
        localStorage.setItem("sidebar-collapsed", c ? "0" : "1");
        document.documentElement.dataset.sidebar = c ? "expanded" : "collapsed";
        window.dispatchEvent(new CustomEvent("sidebar-toggle"));
      } catch { /* ignore */ }
      return !c;
    });
  }

  function navList(coll: boolean, onNavigate?: () => void) {
    return (
      <nav aria-label={t.a11y.mainNav} className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {items.map(({ href, label, icon, badge }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <NavLink
              key={href}
              href={href}
              label={label}
              icon={icon}
              badge={badge}
              active={active}
              collapsed={coll}
              onNavigate={onNavigate}
            />
          );
        })}
      </nav>
    );
  }

  const userBlock = (coll: boolean) => (
    <div className="border-t border-line/70 p-3">
      <div className={cn("glass-subtle flex items-center gap-2.5 rounded-xl p-2.5", coll && "justify-center p-2")}>
        <Avatar name={userName} size="sm" ring />
        {!coll && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-ink">{userName}</p>
            <p className="truncate text-[10px] text-ink-subtle">{workspaceName || t.app.name}</p>
          </div>
        )}
        {!coll && (
          <form action="/api/auth/logout" method="post" onSubmit={() => setLoggingOut(true)}>
            <button
              type="submit"
              disabled={loggingOut}
              aria-label={t.common.logout}
              title={t.common.logout}
              className="rounded-lg p-1.5 text-ink-subtle transition hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
            >
              <LogOut size={15} />
            </button>
          </form>
        )}
      </div>
    </div>
  );

  const brand = (coll: boolean) => (
    <div className={cn("flex items-center gap-2.5 border-b border-line/70 px-4 py-4", coll && "justify-center px-2")}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-glow">
        <MessageSquareText size={17} />
      </span>
      {!coll && (
        <div className="min-w-0">
          <p className="text-sm font-bold leading-5 text-ink">{t.app.name}</p>
          {workspaceName && <p className="truncate text-[11px] text-ink-muted">{workspaceName}</p>}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — glass, RTL: start side = right */}
      <aside
        className={cn(
          "glass-strong fixed inset-y-0 start-0 z-30 hidden flex-col transition-all duration-200 lg:flex",
          collapsed ? "w-[76px]" : "w-64"
        )}
      >
        {brand(collapsed)}
        {navList(collapsed)}
        <div className="mt-auto flex items-center justify-between border-t border-line/70 px-3 py-2">
          {!collapsed && <ThemeToggle />}
          <button
            onClick={toggleCollapse}
            aria-label={collapsed ? "توسيع القائمة" : "طي القائمة"}
            title={collapsed ? "توسيع" : "طي"}
            className="rounded-lg p-2 text-ink-subtle transition hover:bg-surface-3 hover:text-ink"
          >
            {collapsed ? <ChevronsLeft size={16} /> : <ChevronsRight size={16} />}
          </button>
        </div>
        {userBlock(collapsed)}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <div role="dialog" aria-modal="true" aria-label={t.a11y.mainNav} className="glass-strong animate-slide-in absolute inset-y-0 start-0 flex w-72 max-w-[86vw] flex-col">
            <div className="flex items-center justify-between pe-2">
              <div className="flex-1">{brand(false)}</div>
              <button onClick={onClose} aria-label={t.a11y.closeMenu} className="rounded-lg p-2 text-ink-subtle transition hover:bg-surface-3">
                <X size={16} />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{navList(false, onClose)}</div>
            <div className="flex items-center justify-between border-t border-line/70 px-4 py-2">
              <ThemeToggle />
              <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-subtle">
                <Bell size={13} />
                {t.app.name}
              </span>
            </div>
            {userBlock(false)}
          </div>
        </div>
      )}
    </>
  );
}
