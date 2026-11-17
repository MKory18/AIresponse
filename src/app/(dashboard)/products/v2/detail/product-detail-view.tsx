"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Package } from "lucide-react";
import { useCan } from "@/components/auth/permissions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { productReadiness } from "@/modules/products/readiness";
import { readinessChip, stockChip } from "../model";
import { AgentTab } from "./agent-tab";
import { BasicTab } from "./basic-tab";
import { ImagesTab } from "./images-tab";
import { DETAIL_TABS, type DetailTab, type Draft } from "./model";
import { DETAIL_STRINGS as D } from "./strings";
import { useProduct } from "./use-product";

/**
 * صفحة المنتج (3.4ب، 03 §5.4): 3 تبويبات — **الأساسي** · **شو بيقول الوكيل** · **الصور** — وحفظ واحد (شريط لاصق تحت)
 * وتحذير عند الخروج بتعديل مش محفوظ (المتصفح + رابط الرجوع). الصور والأسئلة الشائعة بتنحفظ فورًا.
 */
export function ProductDetailView({ id }: { id: string }) {
  const router = useRouter();
  const can = useCan();
  const { product, draft, setDraft, library, loadError, saveError, saving, dirty, save, discard, reload } = useProduct(id);
  const [tab, setTab] = useState<DetailTab>("basic");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const canWrite = can("products.write");

  // إغلاق التبويب/تحديث الصفحة مع تعديل مش محفوظ.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loadError && !product) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={<Package size={28} strokeWidth={1.5} />}
          title={D.notFound}
          description={loadError}
          action={
            <Link href="/products">
              <Button size="sm" variant="secondary">
                {D.backToList}
              </Button>
            </Link>
          }
        />
      </div>
    );
  }
  if (!product || !draft) {
    return (
      <div className="mx-auto max-w-4xl space-y-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const ready = readinessChip(productReadiness(product));
  const stock = stockChip(product.stockStatus);

  return (
    <div data-product-v2 className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/products"
          onClick={(e) => {
            if (dirty) {
              e.preventDefault();
              setLeaveOpen(true);
            }
          }}
          className="inline-flex items-center gap-1 rounded-control px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          <ArrowRight size={14} aria-hidden /> {D.back}
        </Link>
        <h2 className="min-w-0 truncate text-lg font-semibold text-ink">{product.name}</h2>
        <span dir="ltr" className="text-sm text-ink-muted">
          {product.sku}
        </span>
        <StatusChip tone={stock.tone}>{stock.text}</StatusChip>
        <StatusChip tone={ready.tone}>{ready.text}</StatusChip>
      </div>

      <SegmentedControl<DetailTab> label="أقسام المنتج" value={tab} onChange={setTab} options={DETAIL_TABS} />

      <fieldset disabled={!canWrite} className="min-w-0 space-y-4 border-0 p-0">
        {tab === "basic" && <BasicTab product={product} draft={draft} set={set} />}
        {tab === "agent" && <AgentTab product={product} draft={draft} set={set} />}
        {tab === "images" && <ImagesTab product={product} library={library} onChanged={() => void reload()} />}
      </fieldset>

      {canWrite && tab !== "images" && (
        <div data-save-bar className="sticky bottom-14 z-10 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface-2 px-4 py-3 shadow-overlay md:bottom-0">
          <div role="status" className="min-w-0 text-sm">
            {saveError ? (
              <span role="alert" className="text-danger">
                {saveError}
              </span>
            ) : dirty ? (
              <span className="text-warning">{D.unsaved}</span>
            ) : (
              <span className="text-ink-muted">{D.saved}</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}>
              {D.discard}
            </Button>
            <Button size="sm" loading={saving} disabled={!dirty} onClick={() => void save()}>
              {D.save}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        onConfirm={() => {
          setLeaveOpen(false);
          router.push("/products");
        }}
        title={D.leaveTitle}
        body={D.leaveBody}
        confirmLabel={D.leaveConfirm}
        danger
      />
    </div>
  );
}
