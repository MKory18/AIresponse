"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, ImagePlus, Plus, Search, ArrowUpLeft } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Product = {
  id: string;
  name: string;
  sku: string;
  price: string;
  compareAtPrice: string | null;
  currency: string;
  stockStatus: string;
  category: string | null;
  isActive: boolean;
  isArchived: boolean;
  mediaLinks: { mediaAsset: { url: string; type: string } }[];
  priceTiers: { id: string; label: string; price: string }[];
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  type ImportSummary = {
    usedAI: boolean;
    aiError: string | null;
    mapping: Record<string, string | null>;
    extraPriceColumns: string[];
    created: { id: string; name: string; sku: string; price: string; priceTiers: { label: string; price: string }[] }[];
    skipped: { row: number; reason: string }[];
  };
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    const res = await fetch(`/api/products?${params}`);
    if (!res.ok) {
      setError("فشل تحميل المنتجات");
      return;
    }
    const data = await res.json();
    setProducts(data.items);
    setError(null);
  }, [q, status, category]);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  async function createProduct(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    const form = new FormData(e.currentTarget);
    const payload = {
      name: form.get("name"),
      sku: form.get("sku"),
      price: Number(form.get("price")),
      currency: form.get("currency") || "USD",
      category: form.get("category") || null,
      shortDescription: form.get("shortDescription") || null,
    };
    const res = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setCreating(false);
    if (res.ok) {
      setShowCreate(false);
      formRef.current?.reset();
      load();
    } else {
      const data = await res.json();
      setError(data.message ?? "فشل إنشاء المنتج");
    }
  }

  async function importExcel(file: File) {
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/products/import", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setImportError(body?.message ?? `فشل الاستيراد (رمز ${res.status})`);
        return;
      }
      const summary = (await res.json()) as ImportSummary;
      setImportResult(summary);
      load();
    } catch {
      setImportError("فشل رفع الملف — حاول مرة ثانية");
    } finally {
      setImporting(false);
    }
  }

  async function toggleArchive(p: Product) {
    await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p.isArchived ? { isArchived: false } : { isArchived: true }),
    });
    load();
  }

  async function toggleActive(p: Product) {
    await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    load();
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title={t.pages.productsTitle}
        description={t.pages.productsDesc}
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => { setShowImport(true); setImportError(null); setImportResult(null); }}>
              <FileSpreadsheet size={15} /> استيراد اكسل
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={15} /> منتج جديد
            </Button>
          </>
        }
      />

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-52 flex-1">
          <Search size={16} className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث بالاسم أو SKU أو الوسم…" aria-label={t.common.search} className="ps-11 h-12" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.common.status} className="w-40">
          <option value="active">النشطة</option>
          <option value="inactive">غير النشطة</option>
          <option value="archived">المؤرشفة</option>
          <option value="all">الكل</option>
        </Select>
      </GlassCard>

      {/* Real categories from the loaded products — no invented filters. */}
      {Array.from(new Set(products.map((p) => p.category).filter(Boolean))).length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="التصنيفات">
          <button
            role="tab"
            aria-selected={category === ""}
            onClick={() => setCategory("")}
            className={`rounded-full px-4 py-2 text-[13px] font-semibold transition ${category === "" ? "bg-primary-soft text-primary" : "text-ink-muted hover:bg-surface-hover hover:text-ink"}`}
          >
            الكل
          </button>
          {Array.from(new Set(products.map((p) => p.category).filter(Boolean))).map((c) => (
            <button
              key={c as string}
              role="tab"
              aria-selected={category === c}
              onClick={() => setCategory(category === c ? "" : (c as string))}
              className={`rounded-full px-4 py-2 text-[13px] font-semibold transition ${category === c ? "bg-primary-soft text-primary" : "text-ink-muted hover:bg-surface-hover hover:text-ink"}`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {error && (
        <GlassCard className="p-2">
          <EmptyState title="حدث خطأ" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}

      {loading && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {products.map((p) => {
            const primary = p.mediaLinks[0]?.mediaAsset;
            return (
              <GlassCard key={p.id} className="group flex flex-col overflow-hidden p-3 transition-all duration-200 hover:border-brand-300/80 dark:hover:border-brand-700">
                {primary?.type === "IMAGE" ? (
                  <div className="overflow-hidden rounded-2xl bg-surface-3/70">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={primary.url} alt={p.name} className="h-52 w-full object-contain" loading="lazy" />
                  </div>
                ) : (
                  <div className="flex h-52 w-full items-center justify-center rounded-2xl bg-surface-3/70 text-ink-subtle">
                    <ImagePlus size={28} strokeWidth={1.5} />
                  </div>
                )}
                <div className="flex flex-1 flex-col px-1.5 pb-1.5 pt-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/products/${p.id}`} className="block truncate text-[15px] font-bold text-ink transition hover:text-primary">
                        {p.name}
                      </Link>
                      <p className="num mt-0.5 text-[11px] text-ink-subtle" dir="ltr">{p.sku}</p>
                    </div>
                    <StatusBadge value={p.isArchived ? "CLOSED" : p.isActive ? "IN_STOCK" : "PENDING"} />
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="num text-[15px] font-semibold text-ink-muted" dir="ltr">
                        {Number(p.price).toLocaleString()} {p.currency}
                      </p>
                      {p.priceTiers?.length > 0 && (
                        <p className="num mt-0.5 truncate text-[11px] text-ink-subtle" dir="ltr">
                          {p.priceTiers.slice(0, 2).map((tp) => `${tp.label}: ${Number(tp.price).toLocaleString()}`).join(" · ")}
                          {p.priceTiers.length > 2 ? ` · +${p.priceTiers.length - 2}` : ""}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-[11px] text-ink-subtle">{label(p.stockStatus)}{p.category ? ` · ${p.category}` : ""}</span>
                  </div>
                  <div className="mt-3 flex items-center gap-1.5 border-t border-line/60 pt-3">
                    <Button size="sm" variant="secondary" onClick={() => toggleActive(p)}>
                      {p.isActive ? "تعطيل" : "تفعيل"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleArchive(p)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
                      {p.isArchived ? "استعادة" : "أرشفة"}
                    </Button>
                    <Link
                      href={`/products/${p.id}`}
                      aria-label={`${t.common.details}: ${p.name}`}
                      className="ms-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface-2 text-ink-muted transition hover:border-primary/40 hover:text-primary"
                    >
                      <ArrowUpLeft size={16} className="-scale-x-100" />
                    </Link>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
      {!loading && products.length === 0 && !error && (
        <GlassCard>
          <EmptyState
            illustration="/brand/empty-products.webp"
            title="لا توجد منتجات"
            description="أضف أول منتج لبدء البيع عبر المحادثات."
            action={<Button size="sm" onClick={() => setShowCreate(true)}><Plus size={14} /> منتج جديد</Button>}
          />
        </GlassCard>
      )}

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="منتج جديد">
        <form ref={formRef} onSubmit={createProduct} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="اسم المنتج" className="sm:col-span-2">
            <Input name="name" required placeholder="مثال: عسل طبيعي" />
          </Field>
          <Field label="SKU">
            <Input name="sku" required placeholder="HONEY-001" dir="ltr" className="num" />
          </Field>
          <Field label="السعر">
            <Input name="price" required type="number" step="0.01" min="0" placeholder="0.00" dir="ltr" className="num" />
          </Field>
          <Field label="العملة">
            <Input name="currency" defaultValue="USD" dir="ltr" className="num" />
          </Field>
          <Field label="التصنيف">
            <Input name="category" placeholder="اختياري" />
          </Field>
          <Field label="وصف قصير" className="sm:col-span-2">
            <Input name="shortDescription" placeholder="اختياري" />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={creating}>{creating ? "جارٍ الإنشاء…" : "إنشاء المنتج"}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={showImport} onClose={() => setShowImport(false)} title="استيراد منتجات من ملف اكسل">
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-muted">
            اختر ملف <span className="font-bold" dir="ltr">.xlsx</span> أو <span className="font-bold" dir="ltr">.csv</span> —
            أول صف يكون عناوين الأعمدة (اسم · كود · سعر · أسعار إضافية مثل «سعر الجملة» · تصنيف · كمية…).
            الذكاء يتعرف على الأعمدة ويُدرج المنتجات تلقائيًا، وكل سعر إضافي بعمود بينحفظ على المنتج.
          </p>
          <input
            type="file"
            accept=".xlsx,.csv"
            disabled={importing}
            aria-label="ملف اكسل"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importExcel(f);
              e.target.value = "";
            }}
          />
          {importing && (
            <p className="rounded-xl bg-brand-500/10 px-3 py-2 text-xs font-bold text-brand-700 dark:text-brand-300">
              جارٍ التحليل والإدراج… ما تغلق الصفحة
            </p>
          )}
          {importError && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold leading-relaxed text-red-600 dark:text-red-400">
              {importError}
            </p>
          )}
          {importResult && (
            <div className="space-y-2">
              <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                ادرجت {importResult.created.length} منتج —
                {importResult.usedAI ? " تحليل الأعمدة بالذكاء" : " تحليل الأعمدة تلقائي محلي"}.
                {importResult.skipped.length > 0 ? ` وتخطّت ${importResult.skipped.length} صف (التفاصيل تحت).` : ""}
              </p>
              {importResult.aiError && (
                <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  ملاحظة الذكاء: {importResult.aiError}
                </p>
              )}
              <div className="max-h-48 overflow-y-auto rounded-xl ring-1 ring-inset ring-line">
                {importResult.created.map((p) => (
                  <p key={p.id} className="flex items-center justify-between gap-2 border-b border-line/60 px-3 py-1.5 text-xs last:border-0">
                    <span className="min-w-0 truncate font-semibold text-ink">{p.name}</span>
                    <span className="num shrink-0 text-ink-muted" dir="ltr">
                      {Number(p.price).toLocaleString()}
                      {p.priceTiers.length > 0 ? ` + ${p.priceTiers.length} سعر` : ""}
                    </span>
                  </p>
                ))}
              </div>
              {importResult.skipped.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-xl bg-amber-500/5 ring-1 ring-inset ring-amber-500/20">
                  {importResult.skipped.map((s) => (
                    <p key={s.row} className="border-b border-amber-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-amber-700 last:border-0 dark:text-amber-300">
                      صف {s.row} · {s.reason}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={() => setShowImport(false)}>{t.common.cancel}</Button>
          </div>
        </div>
      </Dialog>

    </div>
  );
}
