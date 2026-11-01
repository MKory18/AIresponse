"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, ChevronDown, ChevronLeft, CircleHelp, Compass, LogOut, Menu, Search, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { groupLanding, pageForPath, type NavGroupView } from "@/lib/nav-model";
import { searchPages } from "@/lib/nav-search";
import { guideForPath, visitGuide } from "@/lib/page-guides";
import { TOUR_SEEN_KEY, shouldAutoStartTour } from "@/lib/guided-tour";
import { startGuidedTour } from "./guided-tour";
import { PageGuidePanel } from "./page-guide";
import { Sidebar } from "./app-sidebar";
import { GroupTabs, TABS_HEIGHT } from "./group-tabs";
import { Avatar } from "./ui/avatar";
import { ThemeToggle } from "./ui/theme-toggle";

export function AppShell({
  groups,
  workspaceName,
  userName,
  children,
}: {
  groups: NavGroupView[];
  workspaceName: string;
  userName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // قفز سريع للصفحات من صندوق البحث (`lib/nav-search.ts`): اقتراحات + أسهم + Enter.
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpIndex, setJumpIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
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

  // شرح الصفحة: بيفتح لحاله **أول زيارة بس** (بعدها «؟» بالشريط العلوي).
  // صندوق الوارد ما بيفتح لحاله — ارتفاعه محسوب ولوحة بتدفعه بتخرّب أعمدته.
  const guideHit = useMemo(() => guideForPath(pathname), [pathname]);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideHref = guideHit?.href ?? null;
  // آخر صفحة عالجناها: React (وضع التطوير) بيشغّل الأثر مرتين، والمرة التانية
  // بتشوف الصفحة «مزارة» وبتسكّر الشرح الي لسا انفتح. المرجع بيمنع إعادة المعالجة.
  const handledGuide = useRef<string | null>(null);
  useEffect(() => {
    if (!guideHref) {
      handledGuide.current = null;
      setGuideOpen(false);
      return;
    }
    if (handledGuide.current === guideHref) return;
    handledGuide.current = guideHref;
    try {
      const r = visitGuide(localStorage.getItem("zr-guide-seen"), guideHref, !fullBleed);
      localStorage.setItem("zr-guide-seen", r.seenRaw);
      setGuideOpen(r.open);
    } catch {
      setGuideOpen(false); // تخزين محجوب (وضع خاص) — الشرح بيبقى بزر «؟»
    }
  }, [guideHref, fullBleed]);
  // الجولة السريعة: مرة وحدة أول دخول للرئيسية (بعدها من زر «جولة»). بتسكّر
  // شرح الصفحة قبل ما تبلّش حتى ما يتراكبوا.
  const runTour = () => {
    setGuideOpen(false);
    startGuidedTour(() => {
      try {
        localStorage.setItem(TOUR_SEEN_KEY, "1");
      } catch { /* ignore */ }
    });
  };
  useEffect(() => {
    let seen: string | null = "1";
    try {
      seen = localStorage.getItem(TOUR_SEEN_KEY);
    } catch { /* تخزين محجوب: ما منشغّلها لحالها */ }
    if (!shouldAutoStartTour(pathname, seen)) return;
    const timer = setTimeout(runTour, 700); // بعد ما ترسم القائمة
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!guideOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGuideOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [guideOpen]);
  // «الخطوة الجاية» بتظهر بس إذا العضو بيقدر يفتح هديك الصفحة.
  // «الفريق» بقائمة الحساب بس لمين بيقدر يفتحها (وإلا ٤٠٣).
  const canTeam = groups.some((g) => g.pages.some((p) => p.href === "/settings/team"));
  const nextAllowed = guideHit
    ? groups.some((g) => g.pages.some((p) => p.href === guideHit.guide.next.href))
    : false;

  // الصفحة الحالية ومجموعتها (أطول رابط مطابق) — منها الفتات وشريط التبويبات.
  const hit = useMemo(() => pageForPath(pathname, groups), [groups, pathname]);
  const tabGroup = hit && hit.group.pages.length > 1 ? hit.group : null;

  const crumbs = useMemo(() => {
    const list = [{ href: "/dashboard", label: t.nav.dashboard }];
    if (hit && hit.page.href !== "/dashboard") {
      list.push({ href: groupLanding(hit.group), label: hit.group.label });
      list.push({ href: hit.page.href, label: hit.page.label });
    }
    return list;
  }, [hit]);

  const matches = useMemo(() => (jumpOpen ? searchPages(query, groups) : []), [jumpOpen, query, groups]);
  const showJump = jumpOpen && matches.length > 0;

  function closeJump() {
    setJumpOpen(false);
    setJumpIndex(-1);
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    // Enter على اقتراح مختار ← الصفحة. بلا اختيار ← بحث المحادثات زي ما كان.
    const picked = jumpIndex >= 0 ? matches[jumpIndex] : undefined;
    if (picked) {
      closeJump();
      setQuery("");
      router.push(picked.href);
      return;
    }
    const q = query.trim();
    if (!q) return;
    closeJump();
    router.push(`/conversations?q=${encodeURIComponent(q)}`);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      closeJump();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length > 0) {
      e.preventDefault();
      const n = matches.length;
      setJumpIndex((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    }
  }

  // اختصار: «/» أو Ctrl+K بيفتح البحث (إلا وإنت بتكتب بحقل). مخفي بالجوال ← ما بيعمل شي.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      const combo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!combo && !slash) return;
      const input = searchRef.current;
      if (!input || input.offsetParent === null) return;
      e.preventDefault();
      input.focus();
      input.select();
      setJumpOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    // `--shell-extra`: ارتفاع شريط التبويبات — صندوق الوارد (شاشة كاملة) بيطرحه
    // من ارتفاعه حتى ما يطلع تمرير زيادة بالصفحة.
    <div className="min-h-screen" style={{ "--shell-extra": tabGroup ? TABS_HEIGHT : "0px" } as React.CSSProperties}>
      <Sidebar
        groups={groups}
        workspaceName={workspaceName}
        userName={userName}
        open={open}
        onClose={() => setOpen(false)}
      />

      {/* Main column offset for the fixed sidebar on desktop (RTL: sidebar on the right) */}
      <div className={cn("flex min-h-screen flex-col transition-[padding] duration-200", narrow ? "lg:ps-[68px]" : "lg:ps-[280px]")}>
        {/* الرأس + التبويبات ثابتين مع التمرير — حتى صفحة طويلة ما تضيّع التنقل. */}
        <div className="sticky top-0 z-20">
          <header className="border-b border-line bg-surface-2">
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
                  <span key={`${i}-${c.label}`} className="flex min-w-0 items-center gap-1">
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
                <form
                  onSubmit={onSearch}
                  role="search"
                  data-tour="search"
                  className="relative hidden md:block"
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeJump();
                  }}
                >
                  <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    value={query}
                    ref={searchRef}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setJumpOpen(true);
                      setJumpIndex(-1);
                    }}
                    onFocus={() => setJumpOpen(true)}
                    onKeyDown={onSearchKey}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={showJump}
                    aria-controls="quick-jump"
                    aria-activedescendant={jumpIndex >= 0 ? "jump-" + jumpIndex : undefined}
                    placeholder={`${t.common.search} أو انتقل لصفحة…`}
                    aria-label={t.common.search}
                    className="h-9 w-56 rounded-lg border border-transparent bg-surface-3 ps-9 pe-3 text-sm text-ink outline-none transition-all placeholder:text-ink-subtle focus:w-72 focus:border-primary focus:bg-surface-2 focus:ring-1 focus:ring-primary"
                  />
                  {showJump && (
                    <ul
                      id="quick-jump"
                      role="listbox"
                      aria-label="الصفحات"
                      className="absolute start-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-line bg-surface-2 py-1 shadow-pop"
                    >
                      {matches.map((m, i) => (
                        <li key={m.href} id={"jump-" + i} role="option" aria-selected={i === jumpIndex}>
                          <Link
                            href={m.href}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              closeJump();
                              setQuery("");
                            }}
                            className={cn(
                              "flex items-center justify-between gap-3 px-3 py-2 text-[13px] transition-colors",
                              i === jumpIndex ? "bg-primary-soft text-primary" : "text-ink hover:bg-surface-hover"
                            )}
                          >
                            <span className="font-semibold">{m.label}</span>
                            <span className="text-[11px] text-ink-subtle">{m.groupLabel}</span>
                          </Link>
                        </li>
                      ))}
                      <li role="presentation" className="border-t border-line px-3 py-1.5 text-[11px] text-ink-subtle">
                        ↑↓ للتنقل · Enter للانتقال · أو اكتب واضغط Enter لتبحث بالمحادثات
                      </li>
                    </ul>
                  )}
                </form>
                {guideHit && (
                  <button
                    type="button"
                    onClick={() => setGuideOpen((o) => !o)}
                    data-tour="help"
                    aria-label="شرح هذه الصفحة"
                    title="شرح هذه الصفحة"
                    aria-expanded={guideOpen}
                    aria-controls={guideOpen ? "page-guide" : undefined}
                    className={cn(
                      "rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink",
                      guideOpen && "bg-primary-soft text-primary"
                    )}
                  >
                    <CircleHelp size={19} strokeWidth={1.75} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={runTour}
                  data-tour="tour"
                  aria-label="جولة سريعة بالموقع"
                  title="جولة سريعة بالموقع"
                  className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  <Compass size={19} strokeWidth={1.75} />
                </button>
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
                      {canTeam && (
                        <Link
                          href="/settings/team"
                          role="menuitem"
                          onClick={() => setAccountOpen(false)}
                          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover"
                        >
                          <Users size={15} className="text-ink-subtle" />
                          {t.nav.team}
                        </Link>
                      )}
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
          {tabGroup && hit && <GroupTabs group={tabGroup} activeHref={hit.page.href} />}
          {guideOpen && guideHit && fullBleed && (
            <PageGuidePanel guide={guideHit.guide} nextAllowed={nextAllowed} overlay onClose={() => setGuideOpen(false)} />
          )}
        </div>
        {guideOpen && guideHit && !fullBleed && (
          <PageGuidePanel guide={guideHit.guide} nextAllowed={nextAllowed} onClose={() => setGuideOpen(false)} />
        )}
        <main className={cn("min-w-0 flex-1", !fullBleed && "p-4 lg:p-6")}>{children}</main>
      </div>
    </div>
  );
}
