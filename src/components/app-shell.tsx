"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, ChevronLeft, Menu, Search } from "lucide-react";
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

      {/* Main column offset for the fixed sidebar on desktop (RTL sidebar on the right) */}
      <div className={cn("flex min-h-screen flex-col transition-all duration-200", narrow ? "lg:ps-[76px]" : "lg:ps-64")}>
        <header className="glass-strong sticky top-0 z-20 border-b border-line/60 shadow-[0_1px_0_rgb(37_99_235/0.08)]">
          <div className="flex h-16 items-center gap-3 px-4 lg:px-6">
            <button
              onClick={() => setOpen(true)}
              aria-label={t.a11y.openMenu}
              className="rounded-xl p-2 text-ink-muted transition hover:bg-surface-3 hover:text-ink lg:hidden"
            >
              <Menu size={19} />
            </button>
            <nav aria-label="breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px]">
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
            <div className="ms-auto flex items-center gap-1.5">
              <form onSubmit={onSearch} role="search" className="relative hidden md:block">
                <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`${t.common.search}…`}
                  aria-label={t.common.search}
                  className="glass-subtle h-9 w-52 rounded-xl ps-9 pe-3 text-[13px] text-ink outline-none transition-all placeholder:text-ink-subtle focus:w-64 focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10"
                />
              </form>
              <Link
                href="/handoffs"
                aria-label={t.nav.handoffs}
                title={t.nav.handoffs}
                className="relative rounded-xl p-2 text-ink-muted transition hover:bg-surface-3 hover:text-ink"
              >
                <Bell size={18} />
                {/* لا نقطة زائفة: العدد الفعلي يظهر داخل صفحة التحويلات نفسها */}
              </Link>
              <ThemeToggle />
              <span className="hidden items-center gap-2 rounded-xl border border-line/70 bg-surface-2/70 py-1 pe-3 ps-1 backdrop-blur sm:inline-flex">
                <Avatar name={userName} size="xs" />
                <span className="max-w-28 truncate text-xs font-semibold text-ink">{userName}</span>
              </span>
            </div>
          </div>
        </header>
        <main className={cn("min-w-0 flex-1", !fullBleed && "p-4 lg:p-6")}>{children}</main>
      </div>
    </div>
  );
}
