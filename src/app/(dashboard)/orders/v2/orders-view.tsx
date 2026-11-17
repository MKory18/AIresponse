"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api-client";
import { ORDER_TABS, orderStatusLabel, type OrderTab } from "@/lib/order-status";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { DateTime, Money } from "@/components/ui/formatted";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { Countdown } from "@/components/ui/countdown";
import { OrderDrawer } from "./order-drawer";
import { ORDERS_STRINGS as S } from "./strings";
import { useOrders, type OrderRow } from "./use-orders";

const TONE: Record<string, Tone> = { info: "info", warn: "warning", ok: "success", bad: "danger", muted: "neutral" };

function StatusCell({ o }: { o: OrderRow }) {
  const s = orderStatusLabel(o);
  const waiting = o.status === "NEW" && !o.heldBy && !o.sealedAt && o.settleAt && new Date(o.settleAt).getTime() > Date.now();
  return (
    <span className="flex items-center gap-2">
      <StatusChip tone={TONE[s.tone] ?? "neutral"} className="max-w-56">
        {s.text}
      </StatusChip>
      {waiting && <Countdown until={o.settleAt!} label="" />}
    </span>
  );
}

const COLUMNS: Column<OrderRow>[] = [
  { key: "order", header: S.columns.order, cell: (o) => <span dir="ltr" className="font-medium">{o.orderNumber}</span> },
  {
    key: "customer",
    header: S.columns.customer,
    cell: (o) => (
      <span className="block">
        <span className="block truncate font-medium">{o.customer.name ?? "—"}</span>
        <span dir="ltr" className="block truncate text-caption text-ink-muted">{o.customer.phone ?? ""}</span>
      </span>
    ),
  },
  { key: "items", header: S.columns.items, cell: (o) => <span className="block max-w-64 truncate text-ink-muted">{o.items.map((i) => `${i.productNameSnapshot} ×${i.quantity}`).join("، ")}</span> },
  { key: "total", header: S.columns.total, align: "end", cell: (o) => <Money amount={o.total} currency={o.currency} /> },
  { key: "status", header: S.columns.status, cell: (o) => <StatusCell o={o} /> },
  { key: "updated", header: S.columns.updated, cell: (o) => <DateTime value={o.updatedAt ?? o.createdAt} mode="relative" className="text-caption text-ink-muted" /> },
];

/**
 * «الطلبات» (3.2، 03 §5.3): تبويبات هي الفلتر (عدّاداتها من الخادم) · بحث · جدول بعمود حالة وحدة وعدد كلي
 * و«حمّل المزيد» · نقرة على صف ← درج الطلب برابط دائم `?order=<id>`.
 */
export function OrdersView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [tab, setTab] = useState<OrderTab>("all");
  const [q, setQ] = useState("");
  const { rows, total, counts, loading, loadingMore, error, hasMore, loadMore, reload } = useOrders(tab, q);

  const openId = params.get("order");
  const inList = useMemo(() => rows.find((o) => o.id === openId) ?? null, [rows, openId]);
  // رابط دائم لطلب مش بأول 25 (أو بتبويب تاني): بنجيبه لحاله بدل ما يطلع الدرج فاضي.
  const [fetched, setFetched] = useState<OrderRow | null>(null);
  useEffect(() => {
    if (!openId || inList) return;
    let alive = true;
    api<OrderRow>(`/api/orders/${openId}`)
      .then((o) => alive && setFetched({ ...o, customer: o.customer ?? { id: "", name: null, phone: null }, items: o.items ?? [] }))
      .catch(() => alive && setFetched(null));
    return () => {
      alive = false;
    };
  }, [openId, inList]);
  const open = inList ?? (fetched && fetched.id === openId ? fetched : null);
  const setOpen = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("order", id);
      else next.delete("order");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router]
  );

  const filtered = tab !== "all" || q.trim().length >= 2;
  return (
    <div data-orders-v2 className="mx-auto max-w-6xl space-y-4">
      <div role="tablist" aria-label="تبويبات الطلبات" className="flex flex-wrap gap-1 border-b border-line">
        {ORDER_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px flex min-h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus",
              tab === t.key ? "border-primary text-primary" : "border-transparent text-ink-muted hover:text-ink"
            )}
          >
            {t.label}
            <CountBadge count={counts[t.key]} showZero tone={t.key === "review" && counts.review > 0 ? "danger" : "neutral"} />
          </button>
        ))}
      </div>

      <div className="relative max-w-md">
        <Search size={16} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={S.search}
          aria-label={S.search}
          className="h-10 w-full rounded-control border border-border-strong bg-surface-2 ps-9 pe-3 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-primary focus:ring-1 focus:ring-focus"
        />
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-ink">
          <span>
            {S.loadError}: {error}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            {S.retry}
          </Button>
        </div>
      )}

      <DataTable
        caption="الطلبات"
        columns={COLUMNS}
        rows={rows}
        rowKey={(o) => o.id}
        loading={loading}
        total={total}
        onLoadMore={hasMore ? () => void loadMore() : undefined}
        loadingMore={loadingMore}
        onRowClick={(o) => setOpen(o.id)}
        empty={filtered ? <EmptyState title={S.emptyFiltered} description={S.emptyFilteredDescription} /> : <EmptyState title={S.emptyTitle} description={S.emptyDescription} />}
      />

      <OrderDrawer order={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />
    </div>
  );
}
