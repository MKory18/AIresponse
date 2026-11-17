"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, ChevronDown, CircleHelp, Compass, LogOut, Menu as MenuIcon, Search, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api-client";
import type { NavGroupView } from "@/lib/nav-model";
import { searchPages } from "@/lib/nav-search";
import { Avatar } from "@/components/ui/avatar";
import { CountBadge } from "@/components/ui/count-badge";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { AttentionPanelView } from "@/components/attention/attention-panel";
import type { AttentionItem } from "@/modules/attention/service";

interface Hit {
  kind: "page" | "customer" | "order";
  href: string;
  title: string;
  subtitle: string;
}
interface Remote {
  customers: { id: string; title: string; subtitle: string; href: string }[];
  orders: { id: string; title: string; subtitle: string; href: string }[];
}

/** بحث شامل: صفحات من المتصفح + عملاء وطلبات من `/api/search` (بعد 250ms من آخر حرف، حد أدنى حرفين). */
function useHits(query: string, groups: readonly NavGroupView[]): Hit[] {
  const [remote, setRemote] = useState<Remote>({ customers: [], orders: [] });
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemote({ customers: [], orders: [] });
      return;
    }
    const id = setTimeout(() => {
      api<Remote>(`/api/search?q=${encodeURIComponent(q)}`).then(setRemote).catch(() => setRemote({ customers: [], orders: [] }));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);
  return useMemo(
    () => [
      ...searchPages(query, groups).map((p): Hit => ({ kind: "page", href: p.href, title: p.label, subtitle: p.groupLabel })),
      ...remote.customers.map((c): Hit => ({ kind: "customer", href: c.href, title: c.title, subtitle: c.subtitle })),
      ...remote.orders.map((o): Hit => ({ kind: "order", href: o.href, title: o.title, subtitle: o.subtitle })),
    ],
    [query, groups, remote]
  );
}

const KIND_LABEL = { page: "صفحة", customer: "عميل", order: "طلب" } as const;

function SearchBox({ groups }: { groups: readonly NavGroupView[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);
  const hits = useHits(query, groups);

  // Ctrl/⌘+K أو «/» (خارج الحقول) بيفتح البحث.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      const combo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      if (!combo && !(e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) return;
      if (!ref.current || ref.current.offsetParent === null) return;
      e.preventDefault();
      ref.current.focus();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    setIndex(-1);
    router.push(href);
  };

  return (
    <form
      role="search"
      className="relative hidden md:block"
      onSubmit={(e) => {
        e.preventDefault();
        const picked = index >= 0 ? hits[index] : undefined;
        if (picked) return go(picked.href);
        if (query.trim()) go(`/conversations?q=${encodeURIComponent(query.trim())}`);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Search size={16} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
      <input
        ref={ref}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length > 0) {
            e.preventDefault();
            setIndex((i) => (e.key === "ArrowDown" ? (i + 1) % hits.length : i <= 0 ? hits.length - 1 : i - 1));
          }
        }}
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls="search-hits"
        aria-label="بحث"
        placeholder="بحث: عميل · رقم · طلب (Ctrl+K)"
        className="h-10 w-64 rounded-control border border-border-strong bg-surface-2 ps-9 pe-3 text-sm text-ink outline-none transition-[width] duration-150 ease-zaki placeholder:text-ink-subtle focus:w-80 focus:border-primary focus:ring-1 focus:ring-focus"
      />
      {open && hits.length > 0 && (
        <ul id="search-hits" role="listbox" className="absolute start-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-card border border-line bg-surface-2 py-1 shadow-overlay">
          {hits.map((h, i) => (
            <li key={`${h.kind}:${h.href}`} role="option" aria-selected={i === index}>
              <Link
                href={h.href}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h.href)}
                className={cn("flex items-center justify-between gap-3 px-3 py-2 text-sm", i === index ? "bg-primary-soft text-primary" : "text-ink hover:bg-surface-hover")}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{h.title}</span>
                  {h.subtitle && <span className="block truncate text-caption text-ink-muted">{h.subtitle}</span>}
                </span>
                <span className="shrink-0 text-xs text-ink-subtle">{KIND_LABEL[h.kind]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** منسدل بسيط: بيسكّر بنقرة برّا أو Esc. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/**
 * رأس الواجهة الجديدة (03 §2): عنوان الصفحة (بلا مسار تنقل) · بحث شامل · «يحتاجك» بعدّاد · قائمة الحساب
 * (المظهر · الشرح والجولة · الخروج). زر «؟» والجولة والمبدّل صارو جوّا قائمة الحساب مش بالرأس.
 */
export function HeaderV2({
  title,
  groups,
  userName,
  attentionCount,
  attentionItems,
  canTeam,
  onOpenMenu,
  onHelp,
  onTour,
}: {
  title: string;
  groups: readonly NavGroupView[];
  userName: string;
  attentionCount: number;
  /** نفس بيانات الاستطلاع الوحيد بالقشرة (ما منستطلع مرتين). */
  attentionItems: readonly AttentionItem[];
  canTeam: boolean;
  onOpenMenu: () => void;
  onHelp: (() => void) | null;
  /** الجولة السريعة مربوطة بمثبّتات `data-tour` (الهيكل القديم) — بتنضاف للجديد بحزمة لاحقة؛ بلا مثبّتات = null. */
  onTour: (() => void) | null;
}) {
  const bell = useDropdown();
  const account = useDropdown();
  const [loggingOut, setLoggingOut] = useState(false);
  const itemCls = "flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm text-ink transition-colors hover:bg-surface-hover";
  return (
    <header className="border-b border-line bg-surface-2">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <button type="button" onClick={onOpenMenu} aria-label="فتح القائمة" className="rounded-control p-2 text-ink-muted hover:bg-surface-hover lg:hidden">
          <MenuIcon size={20} />
        </button>
        <h1 className="min-w-0 truncate text-lg font-semibold text-ink">{title}</h1>
        <div className="ms-auto flex items-center gap-2">
          <SearchBox groups={groups} />
          <div ref={bell.ref} className="relative">
            <button
              type="button"
              onClick={() => bell.setOpen((o) => !o)}
              aria-label={`يحتاجك${attentionCount > 0 ? ` (${attentionCount})` : ""}`}
              aria-expanded={bell.open}
              className="relative flex h-10 items-center gap-1.5 rounded-control px-2.5 text-ink-muted hover:bg-surface-hover hover:text-ink"
            >
              <Bell size={19} aria-hidden />
              <span className="hidden text-sm font-medium sm:inline">يحتاجك</span>
              <CountBadge count={attentionCount} tone="danger" />
            </button>
            {bell.open && (
              <div className="absolute end-0 top-full z-50 mt-1 max-h-[70vh] w-96 max-w-[92vw] overflow-y-auto rounded-card border border-line bg-surface-2 shadow-overlay">
                <AttentionPanelView items={attentionItems} onNavigate={() => bell.setOpen(false)} />
              </div>
            )}
          </div>
          <div ref={account.ref} className="relative">
            <button
              type="button"
              onClick={() => account.setOpen((o) => !o)}
              aria-label="الحساب"
              aria-haspopup="menu"
              aria-expanded={account.open}
              className="inline-flex h-10 items-center gap-2 rounded-control border border-line bg-surface-2 pe-2.5 ps-1 hover:bg-surface-hover"
            >
              <Avatar name={userName} size="xs" />
              <span className="hidden max-w-28 truncate text-sm font-medium text-ink sm:inline">{userName}</span>
              <ChevronDown size={14} className="text-ink-subtle" aria-hidden />
            </button>
            {account.open && (
              <div role="menu" className="absolute end-0 top-full z-50 mt-1 w-56 rounded-card border border-line bg-surface-2 p-1 shadow-overlay">
                <Link href="/settings/account" role="menuitem" onClick={() => account.setOpen(false)} className={itemCls}>
                  <UserRound size={15} aria-hidden /> حسابي
                </Link>
                {canTeam && (
                  <Link href="/settings/team" role="menuitem" onClick={() => account.setOpen(false)} className={itemCls}>
                    <UserRound size={15} aria-hidden /> الفريق
                  </Link>
                )}
                <div className="flex items-center justify-between px-3 py-1.5 text-sm text-ink">
                  <span>المظهر</span>
                  <ThemeToggle />
                </div>
                {onHelp && (
                  <button type="button" role="menuitem" onClick={() => { account.setOpen(false); onHelp(); }} className={itemCls}>
                    <CircleHelp size={15} aria-hidden /> شو هاي الصفحة؟
                  </button>
                )}
                {onTour && (
                  <button type="button" role="menuitem" onClick={() => { account.setOpen(false); onTour(); }} className={itemCls}>
                    <Compass size={15} aria-hidden /> جولة سريعة
                  </button>
                )}
                <form action="/api/auth/logout" method="post" onSubmit={() => setLoggingOut(true)}>
                  <button type="submit" role="menuitem" disabled={loggingOut} className={cn(itemCls, "text-danger hover:bg-danger-soft disabled:opacity-50")}>
                    <LogOut size={15} aria-hidden /> {loggingOut ? "…" : "تسجيل الخروج"}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
