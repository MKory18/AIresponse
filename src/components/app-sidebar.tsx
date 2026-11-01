"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, X, ChevronsRight, ChevronsLeft, Bell, MessageSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { groupLanding, pageForPath, type NavGroupView } from "@/lib/nav-model";
import { Avatar } from "./ui/avatar";
import { BrandLogo } from "./brand-logo";
import { ThemeToggle } from "./ui/theme-toggle";
import { NAV_ICONS } from "./nav-icons";

function NavLink({
  href,
  label,
  icon,
  hint,
  active,
  collapsed,
  onNavigate,
  tour,
}: {
  href: string;
  label: string;
  icon: string;
  /** سطر صغير تحت العنوان: شو جوّا المجموعة (أسماء صفحاتها). */
  hint?: string;
  active: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
  /** علامة الجولة السريعة (`lib/guided-tour.ts`). */
  tour?: string;
}) {
  const Icon = NAV_ICONS[icon] ?? MessageSquare;
  return (
    <Link
      key={href}
      href={href}
      onClick={onNavigate}
      data-tour={tour}
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
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {hint && <span className="mt-0.5 block truncate text-[11px] font-normal text-ink-subtle">{hint}</span>}
        </span>
      )}
    </Link>
  );
}

export function Sidebar({
  groups,
  workspaceName,
  userName,
  open,
  onClose,
}: {
  groups: NavGroupView[];
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

  // المجموعة النشطة = مجموعة أطول رابط مطابق (/orders/[id] بتتبع «المبيعات»).
  const activeKey = pageForPath(pathname, groups)?.group.key;

  function navList(coll: boolean, onNavigate?: () => void) {
    const link = (g: NavGroupView) => (
      <NavLink
        key={g.key}
        href={groupLanding(g)}
        label={g.label}
        icon={g.icon}
        hint={g.pages.length > 1 ? g.pages.map((p) => p.label).join(" · ") : undefined}
        active={g.key === activeKey}
        collapsed={coll}
        onNavigate={onNavigate}
        tour={`group-${g.key}`}
      />
    );
    const main = groups.filter((g) => g.placement === "main");
    const bottom = groups.filter((g) => g.placement === "bottom");
    return (
      <nav aria-label={t.a11y.mainNav} className="flex flex-1 flex-col overflow-y-auto px-2 py-2">
        <div className="space-y-0.5">{main.map(link)}</div>
        {bottom.length > 0 && <div className="mt-auto space-y-0.5 border-t border-line pt-2">{bottom.map(link)}</div>}
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
        data-pane="nav"
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
          <div role="dialog" aria-modal="true" aria-label={t.a11y.mainNav} data-pane="nav" className="animate-slide-in absolute inset-y-0 start-0 flex w-72 max-w-[86vw] flex-col border-e border-line bg-surface-2">
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
