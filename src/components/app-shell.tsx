"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, ChevronDown, ChevronLeft, LogOut, Menu, Search, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Sidebar, type NavEntry } from "./app-sidebar";
import { Avatar } from "./ui/avatar";
import { ThemeToggle } from "./ui/theme-toggle";

export function AppShell({
  navItems,
  workspaceName,
  userName,
  children,
}: {
  navItems: NavEntry[];
  workspaceName: string;
  userName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [narrow, setNarrow] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const sync = () => {
      try {
        setNarrow(localStorage.getItem("sidebar-collapsed") === "1");
      } catch { /* ignore */ }
    };
    sync();
    window.addEventListener("sidebar-toggle", sync);
    return () => window.removeEventListener("sidebar-toggle", sync);
  }, []);
  // Account menu: close on outside click or Escape.
  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (e: PointerEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);
  // The inbox is a full-bleed 3-pane surface; every other page gets page padding.
  const fullBleed = pathname === "/conversations";

  const crumbs = useMemo(() => {
    const found = navItems
      .filter((n) => pathname === n.href || pathname.startsWith(n.href + "/"))
      .sort((a, b) => b.href.length - a.href.length)[0];
    const list = [{ href: "/dashboard", label: t.nav.dashboard }];
    if (found && found.href !== "/dashboard") list.push({ href: found.href, label: found.label });
    return list;
  }, [navItems, pathname]);

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.push(`/conversations?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="min-h-screen"> 
      <Sidebar
        items={navItems}
        workspaceName={workspaceName}
        userName={userName}
        open={open}
        onClose={() => setOpen(false)}
      />

      {/* Main column offset for the fixed sidebar on desktop (RTL: sidebar on the right) */}
      <div className={cn("flex min-h-screen flex-col transition-[padding] duration-200", narrow ? "lg:ps-[68px]" : "lg:ps-[280px]")}>
        <header className="sticky top-0 z-20 border-b border-line bg-surface-2">
          <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
            <button
              onClick={() => setOpen(true)}
              aria-label={t.a11y.openMenu}
              className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink lg:hidden"
            >
              <Menu size={19} />
            </button>
            <nav aria-label="breadcrumb" className="hidden min-w-0 items-center gap-1 text-[13px] xl:flex">
              {crumbs.map((c, i) => (
                <span key={c.href} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronLeft size={14} className="shrink-0 text-ink-subtle" aria-hidden />}
                  <Link
                    href={c.href}
                    className={cn(
                      "truncate transition",
                      i === crumbs.length - 1
                        ? "font-bold text-ink"
                        : "font-medium text-ink-muted hover:text-ink"
                    )}
                  >
                    {c.label}
                  </Link>
                </span>
              ))}
            </nav>
            <div className="ms-auto flex items-center gap-2">
              <form onSubmit={onSearch} role="search" className="relative hidden md:block">
                <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`${t.common.search}…`}
                  aria-label={t.common.search}
                  className="h-9 w-56 rounded-lg border border-transparent bg-surface-3 ps-9 pe-3 text-sm text-ink outline-none transition-all placeholder:text-ink-subtle focus:w-72 focus:border-primary focus:bg-surface-2 focus:ring-1 focus:ring-primary"
                />
              </form>
              <Link
                href="/handoffs"
                aria-label={t.nav.handoffs}
                title={t.nav.handoffs}
                className="relative rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              >
                <Bell size={19} strokeWidth={1.75} />
                {/* لا نقطة زائفة: العدد الفعلي يظهر داخل صفحة التحويلات نفسها */}
              </Link>
              <ThemeToggle />
              <div ref={accountRef} className="relative">
                <button
                  onClick={() => setAccountOpen((o) => !o)}
                  aria-label="الحساب"
                  aria-expanded={accountOpen}
                  aria-haspopup="menu"
                  className={cn(
                    "hidden items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pe-2.5 ps-1 transition-colors hover:bg-surface-hover sm:inline-flex",
                    accountOpen && "border-primary/50 ring-1 ring-primary"
                  )}
                >
                  <Avatar name={userName} size="xs" />
                  <span className="max-w-28 truncate text-[13px] font-semibold text-ink">{userName}</span>
                  <ChevronDown size={14} className="text-ink-subtle" />
                </button>
                {accountOpen && (
                  <div role="menu" className="absolute end-0 top-[calc(100%+6px)] z-30 w-48 rounded-xl border border-line bg-surface-2 p-1 shadow-pop">
                    <Link
                      href="/settings/account"
                      role="menuitem"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover"
                    >
                      <UserRound size={15} className="text-ink-subtle" />
                      حسابي
                    </Link>
                    <Link
                      href="/settings/team"
                      role="menuitem"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover"
                    >
                      <Users size={15} className="text-ink-subtle" />
                      {t.nav.team}
                    </Link>
                    <form action="/api/auth/logout" method="post" onSubmit={() => setLoggingOut(true)}>
                      <button
                        type="submit"
                        role="menuitem"
                        disabled={loggingOut}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        <LogOut size={15} />
                        {loggingOut ? "…" : t.common.logout}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>
        <main className={cn("min-w-0 flex-1", !fullBleed && "p-4 lg:p-6")}>{children}</main>
      </div>
    </div>
  );
}
