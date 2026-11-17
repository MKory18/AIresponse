"use client";

import { useState } from "react";
import { SlidersHorizontal, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { Field, Select } from "@/components/ui/input";
import { formatNumber } from "@/lib/format";
import { ConversationItem, ConversationListEmpty, ConversationListSkeleton } from "@/components/inbox/conversation-item";
import type { ConversationListItem } from "@/components/inbox/types";
import { NO_FILTERS, VIEW_TABS, activeFilterCount, type Filters, type ViewTab } from "./model";

/**
 * قائمة المحادثات (3.1): بحث · تبويبات (الكل · يحتاجك n · جديدة) · الفلاتر كلها بزر «تصفية» واحد
 * · «عرض X من Y» + «حمّل المزيد». التحديث الحي ما بيفضّي القائمة (الدمج بالـhook).
 */
export function ListPane({
  items,
  total,
  loading,
  loadingMore,
  error,
  hasMore,
  view,
  setView,
  q,
  setQ,
  filters,
  setFilters,
  channels,
  attentionCount,
  selectedId,
  onSelect,
  onLoadMore,
  onRetry,
  className,
}: {
  items: ConversationListItem[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  view: ViewTab;
  setView: (v: ViewTab) => void;
  q: string;
  setQ: (q: string) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  channels: { id: string; label: string }[];
  attentionCount: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  className?: string;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const nFilters = activeFilterCount(filters);
  const isFiltered = Boolean(q.trim()) || view !== "all" || nFilters > 0;

  return (
    <aside className={cn("flex w-full flex-col overflow-hidden rounded-card border border-line bg-surface-2 lg:w-80 lg:shrink-0", className)} data-conversation-list>
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="بحث بالاسم أو الرقم أو الرسالة"
              aria-label="بحث"
              className="h-10 w-full rounded-control border border-border-strong bg-surface-2 ps-9 pe-3 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-primary focus:ring-1 focus:ring-focus"
            />
          </div>
          <Button variant="secondary" size="md" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)} className="shrink-0">
            <SlidersHorizontal size={14} aria-hidden /> تصفية
            <CountBadge count={nFilters} />
          </Button>
        </div>
        {filtersOpen && (
          <div className="grid grid-cols-1 gap-2 rounded-control bg-surface-3 p-2" data-filters-panel>
            <Field label="الحالة">
              <Select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters["status"] })}>
                <option value="">الكل</option>
                <option value="OPEN">مفتوحة</option>
                <option value="RESOLVED">منتهية</option>
              </Select>
            </Field>
            <Field label="الصفحة">
              <Select value={filters.channelId} onChange={(e) => setFilters({ ...filters, channelId: e.target.value })}>
                <option value="">كل الصفحات</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="الموظف">
              <Select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value as Filters["assignee"] })}>
                <option value="">الكل</option>
                <option value="me">مسندة إلي</option>
                <option value="none">غير مسندة</option>
              </Select>
            </Field>
            {nFilters > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
                امسح التصفية
              </Button>
            )}
          </div>
        )}
        <div role="tablist" aria-label="عرض المحادثات" className="flex gap-1">
          {VIEW_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={view === t.key}
              onClick={() => setView(t.key)}
              className={cn(
                "flex min-h-9 items-center gap-1.5 rounded-control px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus",
                view === t.key ? "bg-primary-soft text-primary" : "text-ink-muted hover:bg-surface-hover hover:text-ink"
              )}
            >
              {t.label}
              {t.key === "attention" && <CountBadge count={attentionCount} tone="danger" />}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" role="listbox" aria-label="المحادثات">
        {loading && <ConversationListSkeleton />}
        {error && (
          <div role="alert" className="p-4 text-center">
            <p className="text-sm text-danger">{error}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
              أعد المحاولة
            </Button>
          </div>
        )}
        {!loading && !error && items.length === 0 && <ConversationListEmpty isFiltered={isFiltered} />}
        {!loading && items.map((c) => <ConversationItem key={c.id} conversation={c} selected={c.id === selectedId} onSelect={onSelect} />)}
      </div>

      {!loading && items.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-line bg-surface-3 px-3 py-2 text-caption text-ink-muted">
          <span data-list-count>
            عرض {formatNumber(items.length, 0)} من {formatNumber(total, 0)}
          </span>
          {hasMore && (
            <Button size="sm" variant="secondary" loading={loadingMore} onClick={onLoadMore}>
              حمّل المزيد
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
