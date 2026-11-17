"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, FileSpreadsheet, ImageOff, Plus, RotateCcw, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { Can } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { DateTime, Money } from "@/components/ui/formatted";
import { Menu } from "@/components/ui/menu";
import { StatusChip } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";
import { CreateProductDialog } from "./create-dialog";
import { ImportProductsDialog } from "./import-dialog";
import { STATUS_TABS, readinessChip, stockChip, type StatusFilter } from "./model";
import { RowToggle } from "./row-toggle";
import { PRODUCTS_STRINGS as S } from "./strings";
import { useProducts, type ProductRow } from "./use-products";

function Thumb({ p }: { p: ProductRow }) {
  const img = p.mediaLinks[0]?.mediaAsset;
  return img?.type === "IMAGE" ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={img.url} alt="" className="h-10 w-10 shrink-0 rounded-control bg-surface-3 object-cover" loading="lazy" />
  ) : (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-surface-3 text-ink-subtle">
      <ImageOff size={16} aria-hidden />
    </span>
  );
}

/**
 * «المنتجات» (3.4ب، 03 §5.4): جدول بصورة · اسم · رمز · سعر · **مخزون** (شارة متوفر/غير متوفر) · **شغّال** (مفتاح) ·
 * **جاهز للوكيل؟** (ناقص: وصف · صورة). فلاتر من الخادم + «ناقصة المحتوى». لما الـ OMS مربوط: سطر مصدر المنتجات،
 * و«أضف منتج» و«استيراد اكسل» بيختفوا (بتيجي منه).
 */
export function ProductsView() {
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>("active");
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { rows, total, hasMore, oms, loading, loadingMore, error, reload, loadMore, patch } = useProducts(status, q);

  async function apply(id: string, body: { isActive?: boolean; isArchived?: boolean }, ok: string) {
    const err = await patch(id, body);
    toast.show(err ?? ok, err ? "error" : "success");
  }

  const columns: Column<ProductRow>[] = [
    {
      key: "product",
      header: S.columns.product,
      cell: (p) => (
        <span className="flex items-center gap-3">
          <Thumb p={p} />
          <span className="min-w-0">
            <Link href={`/products/${p.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium text-ink hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">
              {p.name}
            </Link>
            <span dir="ltr" className="block truncate text-start text-caption text-ink-muted">
              {p.sku}
            </span>
          </span>
        </span>
      ),
    },
    { key: "price", header: S.columns.price, align: "end", cell: (p) => <Money amount={p.price} currency={p.currency} /> },
    {
      key: "stock",
      header: S.columns.stock,
      cell: (p) => {
        const c = stockChip(p.stockStatus);
        return <StatusChip tone={c.tone}>{c.text}</StatusChip>;
      },
    },
    {
      key: "active",
      header: S.columns.active,
      cell: (p) => (
        <Can permission="products.write" fallback={<span className="text-sm text-ink-muted">{p.isActive ? "شغّال" : "متوقف"}</span>}>
          <RowToggle checked={p.isActive} label={`${S.columns.active}: ${p.name}`} disabled={p.isArchived} onChange={(next) => void apply(p.id, { isActive: next }, S.saved)} />
        </Can>
      ),
    },
    {
      key: "ready",
      header: S.columns.ready,
      cell: (p) => {
        const c = readinessChip(p.readiness);
        return (
          <StatusChip tone={c.tone} className="max-w-48">
            {c.text}
          </StatusChip>
        );
      },
    },
    {
      key: "actions",
      header: "",
      cell: (p) => (
        <Can permission="products.write">
          <span onClick={(e) => e.stopPropagation()}>
            <Menu
              label={`${S.actions}: ${p.name}`}
              items={[
                p.isArchived
                  ? { key: "restore", label: S.restore, icon: <RotateCcw size={14} aria-hidden />, onSelect: () => void apply(p.id, { isArchived: false }, S.saved) }
                  : { key: "archive", label: S.archive, icon: <Archive size={14} aria-hidden />, onSelect: () => void apply(p.id, { isArchived: true }, S.saved) },
              ]}
            />
          </span>
        </Can>
      ),
    },
  ];

  const filtered = status !== "active" || q.trim().length >= 2;
  return (
    <div data-products-v2 className="mx-auto max-w-6xl space-y-4">
      {oms.connected && (
        <div data-oms-line className="rounded-card border border-info/40 bg-info-soft px-4 py-3 text-sm text-ink">
          <p>
            {S.omsLine} — {S.omsLast}: {oms.lastSyncAt ? <DateTime value={oms.lastSyncAt} mode="relative" /> : S.omsNever}.
          </p>
          <p className="mt-1 text-ink-muted">
            {S.omsAdd} {S.omsHint}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="فلتر المنتجات" className="flex flex-wrap gap-1 border-b border-line">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={status === t.key}
              onClick={() => setStatus(t.key)}
              className={cn(
                "-mb-px min-h-10 border-b-2 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus",
                status === t.key ? "border-primary text-primary" : "border-transparent text-ink-muted hover:text-ink"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {!oms.connected && (
          <Can permission="products.write">
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
                <FileSpreadsheet size={15} aria-hidden /> {S.import}
              </Button>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus size={15} aria-hidden /> {S.add}
              </Button>
            </div>
          </Can>
        )}
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

      <DataTable<ProductRow>
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        onRowClick={(p) => router.push(`/products/${p.id}`)}
        loading={loading}
        total={total}
        onLoadMore={hasMore ? () => void loadMore() : undefined}
        loadingMore={loadingMore}
        caption="المنتجات"
        empty={
          <EmptyState
            title={filtered ? S.emptyFiltered : S.empty}
            description={filtered ? undefined : S.emptyHint}
            action={
              !filtered && !oms.connected ? (
                <Can permission="products.write">
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus size={14} aria-hidden /> {S.add}
                  </Button>
                </Can>
              ) : undefined
            }
          />
        }
      />

      <CreateProductDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ImportProductsDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={() => void reload()} />
    </div>
  );
}
