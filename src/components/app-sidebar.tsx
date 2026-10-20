"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, MessageSquare, Users, Package, ShoppingBag, Images,
  MessageCircle, BookOpen, UserRound, FlaskConical, Radio, Workflow, Clock,
  Hand, ChartNoAxesCombined, Settings, LogOut, X,
  ChevronsRight, ChevronsLeft, Bell, SlidersHorizontal, GitBranch, Megaphone,
  Cable, Bot, LibraryBig,
} from "lucide-react";
import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Avatar } from "./ui/avatar";
import { BrandLogo } from "./brand-logo";
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
  GitBranch,
  Megaphone,
  Clock,
  Hand,
  BarChart3: ChartNoAxesCombined,
  ChartNoAxesCombined,
  Settings,
  SlidersHorizontal,
  Cable,
  AgentBot: Bot,
  LibraryBig,
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
        "group relative mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors duration-150",
        active
          ? "bg-primary-soft font-semibold text-brand-700 dark:text-brand-200"
          : "text-ink-muted hover:bg-surface-hover hover:text-ink",
        collapsed && "justify-center px-0"
      )}
    >
      {active && (
        <span aria-hidden className="absolute start-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
      )}
      <Icon
        size={18}
        strokeWidth={active ? 2 : 1.75}
        className={cn("shrink-0 transition-colors", active ? "text-primary" : "text-ink-subtle group-hover:text-ink-muted")}
      />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge && (
        <span className={cn(
          "num flex h-5 min-w-5 items-center justify-center rounded-[4px] px-1 text-[10px] font-bold",
          active ? "bg-primary text-white" : "bg-surface-3 text-ink-muted"
        )}>
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

  // الرابط الأطول المطابق بس هو النشط (/orders/[id] مش /orders كمان).
  const activeHref = items
    .map((i) => i.href)
    .filter((href) => pathname === href || pathname.startsWith(href + "/"))
    .sort((a, b) => b.length - a.length)[0];

  function navList(coll: boolean, onNavigate?: () => void) {
    return (
      <nav aria-label={t.a11y.mainNav} className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {items.map(({ href, label, icon, badge }) => {
          const active = href === activeHref;
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
    <div className="border-t border-line p-2">
      <div className={cn("flex items-center gap-2.5 rounded-lg p-1.5", coll && "justify-center p-1")}>
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
    <div className={cn("flex items-center gap-2.5 px-3 pb-2 pt-3", coll && "justify-center px-2")}>
      <BrandLogo size="md" />
      {!coll && (
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold leading-5 text-ink">
            Zaki <span className="text-primary">response</span>
          </p>
          {workspaceName && <p className="truncate text-[11px] text-ink-muted">{workspaceName}</p>}
        </div>
      )}
      <button
        onClick={toggleCollapse}
        aria-label={coll ? "توسيع القائمة" : "طي القائمة"}
        title={coll ? "توسيع" : "طي"}
        className="shrink-0 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
      >
        {coll ? <ChevronsLeft size={17} /> : <ChevronsRight size={17} />}
      </button>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — flush Fluent navigation pane, RTL: start side = right */}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-30 hidden flex-col border-e border-line bg-surface-2 transition-[width] duration-200 lg:flex",
          collapsed ? "w-[68px]" : "w-[280px]"
        )}
      >
        {brand(collapsed)}
        {navList(collapsed)}
        {userBlock(collapsed)}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
          <div role="dialog" aria-modal="true" aria-label={t.a11y.mainNav} className="animate-slide-in absolute inset-y-0 start-0 flex w-72 max-w-[86vw] flex-col border-e border-line bg-surface-2">
            <div className="flex items-center justify-between pe-2">
              <div className="flex-1">{brand(false)}</div>
              <button onClick={onClose} aria-label={t.a11y.closeMenu} className="rounded-lg p-2 text-ink-subtle transition hover:bg-surface-3">
                <X size={16} />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{navList(false, onClose)}</div>
            <div className="flex items-center justify-between border-t border-line px-4 py-2">
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
