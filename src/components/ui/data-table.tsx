"use client";

import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { Button } from "./button";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /** محاذاة العمود — الأرقام والمبالغ بتنحط `end` (يسار بالـRTL). */
  align?: "start" | "end";
  className?: string;
}

/**
 * `DataTable` — الجدول الموحّد (2.1): رأس ثابت · صف قابل للنقر · تحميل (هياكل) · فراغ · «تحميل المزيد» + «عرض X من Y».
 * القاعدة (03 §6.4): الإجمالي من الخادم (`total`) — ممنوع عدّاد محسوب من الصفوف المحمّلة.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  empty,
  total,
  onLoadMore,
  loadingMore = false,
  caption,
  className,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  /** ما يُعرض لما ما في صفوف (EmptyState + فعل). */
  empty?: React.ReactNode;
  /** العدد الكلي من الخادم. */
  total?: number;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** وصف الجدول لقارئ الشاشة. */
  caption?: string;
  className?: string;
}) {
  const showEmpty = !loading && rows.length === 0;
  const hasMore = typeof total === "number" && rows.length < total && !!onLoadMore;

  return (
    <div className={cn("overflow-hidden rounded-card border border-line bg-surface-2", className)}>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10 bg-surface-3">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    "border-b border-line px-4 py-2.5 text-xs font-medium text-ink-muted",
                    c.align === "end" ? "text-end" : "text-start",
                    c.className
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`} data-skeleton-row className="border-b border-line last:border-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3">
                      <div className="h-4 w-3/4 animate-pulse rounded bg-surface-3" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading &&
              rows.map((row) => {
                const clickable = !!onRowClick;
                return (
                  <tr
                    key={rowKey(row)}
                    onClick={clickable ? () => onRowClick(row) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRowClick(row);
                            }
                          }
                        : undefined
                    }
                    tabIndex={clickable ? 0 : undefined}
                    className={cn(
                      "border-b border-line last:border-0",
                      clickable && "cursor-pointer transition-colors duration-100 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus"
                    )}
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={cn("px-4 py-3 text-ink", c.align === "end" ? "text-end tabular-nums" : "text-start", c.className)}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
        {showEmpty && <div data-table-empty className="p-6">{empty}</div>}
      </div>
      {!loading && rows.length > 0 && typeof total === "number" && (
        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-3 px-4 py-2.5 text-caption text-ink-muted">
          <span data-table-count>
            عرض {formatNumber(rows.length, 0)} من {formatNumber(total, 0)}
          </span>
          {hasMore && (
            <Button size="sm" variant="secondary" loading={loadingMore} onClick={onLoadMore}>
              حمّل المزيد
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
