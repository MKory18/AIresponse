"use client";

import { cn } from "@/lib/cn";

export interface InboxPageRow {
  id: string;
  type: string;
  displayName: string | null;
  externalId: string | null;
  status: string;
  unreadCount: number;
}

function initialsOf(p: InboxPageRow): string {
  const name = p.displayName || p.externalId || "?";
  return name.trim().slice(0, 1);
}

/**
 * Inbox page switcher — real workspace channels above the thread list.
 * NeoCommerce calm: white chips, light borders, blue active pill, RTL-safe
 * horizontal scroll. Never invents pages: rows come from the server.
 */
export function PageSwitcher({
  pages,
  selectedId,
  loading,
  error,
  onSelect,
  onRetry,
}: {
  pages: InboxPageRow[];
  selectedId: string;
  loading: boolean;
  error: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex gap-1.5 overflow-hidden" aria-label="تحميل الصفحات">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-8 w-24 shrink-0 animate-pulse rounded-full bg-surface-3" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-ink-muted">تعذر تحميل الصفحات — تعرض كل المحادثات.</p>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold text-brand-600 transition hover:bg-brand-500/10"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }
  if (pages.length === 0) return null;
  return (
    <div
      className="flex gap-1.5 overflow-x-auto pb-0.5"
      role="tablist"
      aria-label="صفحات فيسبوك"
    >
      <button
        key="all"
        type="button"
        role="tab"
        aria-selected={selectedId === ""}
        onClick={() => onSelect("")}
        className={cn(
          "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-bold transition-all",
          selectedId === ""
            ? "bg-primary text-white shadow-xs"
            : "border border-line bg-surface-2 text-ink-muted hover:text-ink"
        )}
      >
        كل الصفحات
      </button>
      {pages.map((p) => {
        const active = selectedId === p.id;
        const connected = p.status === "CONNECTED";
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={p.displayName || p.externalId || p.id}
            onClick={() => onSelect(active ? "" : p.id)}
            className={cn(
              "flex max-w-44 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[12px] font-bold transition-all",
              active
                ? "bg-primary text-white shadow-xs"
                : "border border-line bg-surface-2 text-ink-muted hover:text-ink"
            )}
          >
            <span
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                active ? "bg-white/25 text-white" : "bg-brand-500/10 text-brand-600"
              )}
              aria-hidden
            >
              {initialsOf(p)}
            </span>
            <span className="truncate">{p.displayName || p.externalId || "صفحة"}</span>
            <span
              className={cn("h-1.5 w-1.5 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-ink-subtle")}
              title={connected ? "متصلة" : p.status}
              aria-hidden
            />
            {p.unreadCount > 0 && (
              <span
                className={cn(
                  "num rounded-full px-1.5 text-[10px] font-bold",
                  active ? "bg-white/25 text-white" : "bg-brand-500/10 text-brand-600"
                )}
              >
                {p.unreadCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Read the persisted page filter (?channelId=) — client only. */
export function readSelectedChannelId(): string {
  try {
    return new URLSearchParams(window.location.search).get("channelId") ?? "";
  } catch {
    return "";
  }
}

/** Persist the page filter (?channelId=) without navigation. */
export function writeSelectedChannelId(id: string): void {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("channelId", id);
    else url.searchParams.delete("channelId");
    window.history.replaceState(null, "", url);
  } catch {
    /* ignore */
  }
}

/** Keep only ids the server actually returned (no crafted-id persistence). */
export function sanitizeSelectedChannelId(id: string, pages: InboxPageRow[]): string {
  if (!id) return "";
  return pages.some((p) => p.id === id) ? id : "";
}
