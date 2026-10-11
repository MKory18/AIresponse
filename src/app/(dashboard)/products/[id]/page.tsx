"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowDown, ArrowRight, ArrowUp, BadgeDollarSign, FileText, Images, Package, Star, Upload } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { ComplianceCard } from "@/components/products/compliance-card";

type MediaAsset = { id: string; url: string; type: string; title: string | null; category: string };
type Faq = { id: string; question: string; answer: string; isActive: boolean };
type ProductDetail = {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  shortDescription: string | null;
  price: string;
  compareAtPrice: string | null;
  currency: string;
  stockStatus: string;
  stockQty: number;
  category: string | null;
  tags: string[];
  benefits: string[];
  ingredients: string | null;
  usage: string | null;
  warnings: string | null;
  objections: string[];
  salesNotes: string | null;
  isActive: boolean;
  isArchived: boolean;
  variants: { id: string; name: string; sku: string; price: string; stockQty: number }[];
  mediaLinks: { mediaAsset: MediaAsset; isPrimary: boolean; sortOrder: number }[];
  faqs: Faq[];
};

const TABS = [
  { key: "overview", label: "نظرة عامة" },
  { key: "pricing", label: "التسعير" },
  { key: "content", label: "المحتوى البيعي" },
  { key: "media", label: "الوسائط" },
  { key: "faqs", label: "الأسئلة الشائعة" },
  { key: "compliance", label: "الامتثال" },
];

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [newFaq, setNewFaq] = useState({ question: "", answer: "" });
  const [tab, setTab] = useState("overview");
  const [mediaSearch, setMediaSearch] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const productFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/products/${params.id}`);
    if (!res.ok) {
      setError("المنتج غير موجود");
      return;
    }
    setProduct(await res.json());
    const mediaRes = await fetch("/api/media?limit=50");
    if (mediaRes.ok) setMediaAssets((await mediaRes.json()).items);
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function patchSection(section: string, form: HTMLFormElement) {
    const fd = new FormData(form);
    setSaving(true);
    setSaved(false);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of fd.entries()) {
      if (key === "price" || key === "compareAtPrice") {
        payload[key] = value === "" ? null : Number(value);
      } else if (["benefits", "objections", "tags"].includes(key)) {
        payload[key] = String(value).split("\n").map((s) => s.trim()).filter(Boolean);
      } else {
        payload[key] = value === "" ? null : value;
      }
    }
    const res = await fetch(`/api/products/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      load();
      setTimeout(() => setSaved(false), 2000);
    } else {
      const data = await res.json();
      setError(data.message ?? "فشل الحفظ");
    }
    void section;
  }

  async function attachMedia(mediaAssetId: string) {
    await fetch(`/api/products/${params.id}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaAssetId }),
    });
    load();
  }

  async function detachMedia(mediaAssetId: string) {
    await fetch(`/api/products/${params.id}/media`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaAssetId }),
    });
    load();
  }

  async function setPrimary(mediaAssetId: string) {
    await fetch(`/api/products/${params.id}/media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaAssetId }),
    });
    load();
  }

  async function uploadProductImage(file: File) {
    const form = new FormData();
    form.append("file", file);
    form.append("category", "PRODUCT");
    form.append("productId", params.id);
    setUploadingImage(true);
    try {
      const res = await fetch("/api/media/upload", { method: "POST", body: form });
      if (!res.ok) {
        // Show the real server reason (status + error code + message) instead
        // of a generic phrase that hides the root cause.
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        const msg = body?.message ?? "";
        const code = body?.error ?? "";
        let detail = msg || code || `HTTP ${res.status}`;
        if (code && msg && msg !== code) detail = `${msg} [code=${code}]`;
        setError(`${t.media.uploadFailed}: ${detail}`);
      } else {
        load();
      }
    } finally {
      setUploadingImage(false);
    }
  }

  async function moveMedia(mediaAssetId: string, dir: -1 | 1) {
    if (!product) return;
    const ids = product.mediaLinks.map((l) => l.mediaAsset.id);
    const idx = ids.indexOf(mediaAssetId);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= ids.length) return;
    [ids[idx], ids[next]] = [ids[next], ids[idx]];
    await fetch(`/api/products/${params.id}/media`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedMediaIds: ids }),
    });
    load();
  }

  async function addFaq() {
    if (!newFaq.question.trim() || !newFaq.answer.trim()) return;
    await fetch("/api/faqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...newFaq, productId: params.id }),
    });
    setNewFaq({ question: "", answer: "" });
    load();
  }

  async function toggleFaq(faq: Faq) {
    await fetch(`/api/faqs/${faq.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !faq.isActive }),
    });
    load();
  }

  if (error && !product) {
    return (
      <div className="page-wrap">
        <GlassCard className="p-2">
          <EmptyState
            icon={<Package size={28} strokeWidth={1.5} />}
            title="المنتج غير موجود"
            description={error}
            action={<Link href="/products"><Button size="sm" variant="secondary">العودة للمنتجات</Button></Link>}
          />
        </GlassCard>
      </div>
    );
  }
  if (!product) {
    return (
      <div className="page-wrap space-y-3">
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }

  const attachedIds = new Set(product.mediaLinks.map((l) => l.mediaAsset.id));

  return (
    <div className="page-wrap">
      <PageHeader
        title={product.name}
        description={`${product.sku} · ${label(product.stockStatus)}`}
        actions={
          <>
            <Link href="/products" className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-ink-muted transition hover:bg-surface-3 hover:text-ink">
              <ArrowRight size={14} />
              المنتجات
            </Link>
            {saved && <Badge tone="DELIVERED" dot>تم الحفظ</Badge>}
          </>
        }
      />
      {error && (
        <GlassCard level="glass-subtle" className="border-red-500/20 px-4 py-2.5 text-sm text-red-600 dark:text-red-400">{error}</GlassCard>
      )}

      <Tabs items={TABS} activeKey={tab} onSelect={setTab} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Overview */}
        {tab === "overview" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              patchSection("overview", e.currentTarget);
            }}
            className="space-y-3 xl:col-span-2"
          >
            <GlassCard className="grid grid-cols-1 gap-3 p-4 sm:p-5 md:grid-cols-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-ink md:col-span-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
                  <Package size={15} />
                </span>
                نظرة عامة
              </h2>
              <Field label="الاسم">
                <Input name="name" defaultValue={product.name} />
              </Field>
              <Field label="SKU">
                <Input name="sku" defaultValue={product.sku} dir="ltr" className="num" />
              </Field>
              <Field label="وصف قصير" className="md:col-span-2">
                <Input name="shortDescription" defaultValue={product.shortDescription ?? ""} />
              </Field>
              <Field label="الوصف الكامل" className="md:col-span-2">
                <Textarea name="description" defaultValue={product.description ?? ""} rows={4} />
              </Field>
              <Field label="التصنيف">
                <Input name="category" defaultValue={product.category ?? ""} />
              </Field>
              <Field label="الوسوم (سطر لكل وسم)">
                <Textarea name="tags" defaultValue={product.tags.join("\n")} rows={2} />
              </Field>
              <div className="flex justify-end md:col-span-2">
                <Button type="submit" loading={saving} disabled={saving}>حفظ</Button>
              </div>
            </GlassCard>
          </form>
        )}

        {/* Pricing */}
        {tab === "pricing" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              patchSection("pricing", e.currentTarget);
            }}
            className="space-y-3 xl:col-span-2"
          >
            <GlassCard className="space-y-3 p-4 sm:p-5">
              <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                  <BadgeDollarSign size={15} />
                </span>
                التسعير
              </h2>
              <p className="rounded-xl bg-brand-500/10 px-3 py-2 text-xs leading-relaxed text-brand-700 ring-1 ring-inset ring-brand-500/20 dark:text-brand-300">
                السعر هنا هو المصدر الوحيد للحقيقة في النظام — الذكاء الاصطناعي لا يحدد الأسعار أبدًا.
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label="السعر">
                  <Input name="price" type="number" step="0.01" min="0" defaultValue={product.price} dir="ltr" className="num" />
                </Field>
                <Field label="السعر قبل الخصم">
                  <Input name="compareAtPrice" type="number" step="0.01" min="0" defaultValue={product.compareAtPrice ?? ""} dir="ltr" className="num" />
                </Field>
                <Field label="العملة">
                  <Input name="currency" defaultValue={product.currency} dir="ltr" className="num" />
                </Field>
              </div>
              {product.variants.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-xs font-bold text-ink-muted">الخيارات</h3>
                  <div className="space-y-1">
                    {product.variants.map((v) => (
                      <p key={v.id} className="glass-subtle flex justify-between rounded-lg px-3 py-1.5 text-xs text-ink-muted" dir="ltr">
                        <span>{v.name} ({v.sku})</span>
                        <span className="num">{Number(v.price).toLocaleString()} · {v.stockQty}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <Button type="submit" loading={saving} disabled={saving}>حفظ</Button>
              </div>
            </GlassCard>
          </form>
        )}

        {/* Benefits / usage / objections */}
        {tab === "content" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              patchSection("content", e.currentTarget);
            }}
            className="space-y-3 xl:col-span-2"
          >
            <GlassCard className="grid grid-cols-1 gap-3 p-4 sm:p-5 md:grid-cols-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-ink md:col-span-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-300">
                  <FileText size={15} />
                </span>
                الفوائد والاستخدام والملاحظات
              </h2>
              <Field label="الفوائد (سطر لكل فائدة)">
                <Textarea name="benefits" defaultValue={product.benefits.join("\n")} rows={3} />
              </Field>
              <Field label="المكونات">
                <Textarea name="ingredients" defaultValue={product.ingredients ?? ""} rows={3} />
              </Field>
              <Field label="طريقة الاستخدام">
                <Textarea name="usage" defaultValue={product.usage ?? ""} rows={2} />
              </Field>
              <Field label="التحذيرات">
                <Textarea name="warnings" defaultValue={product.warnings ?? ""} rows={2} />
              </Field>
              <Field label="الاعتراضات الشائعة (سطر لكل اعتراض)">
                <Textarea name="objections" defaultValue={product.objections.join("\n")} rows={2} />
              </Field>
              <Field label="ملاحظات البيع">
                <Textarea name="salesNotes" defaultValue={product.salesNotes ?? ""} rows={2} />
              </Field>
              <div className="flex justify-end md:col-span-2">
                <Button type="submit" loading={saving} disabled={saving}>حفظ</Button>
              </div>
            </GlassCard>
          </form>
        )}

        {/* Media */}
        {tab === "media" && (
          <GlassCard className="space-y-3 p-4 sm:p-5 xl:col-span-2">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
                <Images size={15} />
              </span>
              {t.media.productImages}
            </h2>
            <div className="grid grid-cols-3 gap-2">
              {product.mediaLinks.map((link) => (
                <div key={link.mediaAsset.id} className="glass-subtle space-y-1.5 rounded-xl p-1.5 text-center">
                  {link.mediaAsset.type === "IMAGE" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={link.mediaAsset.url} alt="" className="h-20 w-full rounded-lg object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-20 items-center justify-center rounded-lg bg-surface-3 text-xs font-semibold text-ink-subtle">{link.mediaAsset.type}</div>
                  )}
                  {link.isPrimary && (
                    <Badge tone="NEW" className="mx-auto">
                      <Star size={9} fill="currentColor" />
                      {t.media.primary}
                    </Badge>
                  )}
                  <div className="flex flex-wrap justify-center gap-1">
                    {!link.isPrimary && (
                      <Button size="sm" variant="secondary" onClick={() => setPrimary(link.mediaAsset.id)}>{t.media.setPrimary}</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => moveMedia(link.mediaAsset.id, -1)} aria-label="تقديم">
                      <ArrowUp size={12} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => moveMedia(link.mediaAsset.id, 1)} aria-label="تأخير">
                      <ArrowDown size={12} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => detachMedia(link.mediaAsset.id)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">{t.media.removeFromProduct}</Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" loading={uploadingImage} disabled={uploadingImage} onClick={() => productFileRef.current?.click()}>
                <Upload size={13} />
                {t.media.uploadNew}
              </Button>
              <input
                ref={productFileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadProductImage(f);
                  e.target.value = "";
                }}
              />
            </div>
            <details className="glass-subtle rounded-xl p-3">
              <summary className="cursor-pointer text-xs font-bold text-ink-muted">{t.media.addImage}</summary>
              <Input
                value={mediaSearch}
                onChange={(e) => setMediaSearch(e.target.value)}
                placeholder={`${t.common.search}…`}
                aria-label={t.common.search}
                className="mt-2"
              />
              <div className="mt-2 grid max-h-52 grid-cols-3 gap-2 overflow-y-auto">
                {mediaAssets
                  .filter((m) => !attachedIds.has(m.id))
                  .filter((m) => !mediaSearch || (m.title ?? "").includes(mediaSearch))
                  .map((m) => (
                    <button key={m.id} onClick={() => attachMedia(m.id)} className="rounded-xl border border-line p-1 text-[10px] text-ink-muted transition hover:border-brand-400 hover:text-ink">
                      {m.type === "IMAGE" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.url} alt="" className="h-16 w-full rounded-lg object-cover" loading="lazy" />
                      ) : (
                        <span>{m.type}</span>
                      )}
                      <span className="mt-1 block truncate">{m.title ?? m.id}</span>
                    </button>
                  ))}
              </div>
            </details>
          </GlassCard>
        )}

        {/* P12 — قواعد الادعاءات من سيستم 1 */}
        {tab === "compliance" && <ComplianceCard productId={product.id} />}

        {/* FAQs */}
        {tab === "faqs" && (
          <GlassCard className="space-y-3 p-4 sm:p-5 xl:col-span-2">
            <h2 className="text-sm font-bold text-ink">أسئلة شائعة (بيانات منظمة — يستخدمها AI مباشرة)</h2>
            {product.faqs.map((f) => (
              <div key={f.id} className="glass-subtle flex items-start justify-between gap-2 rounded-xl p-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-ink">{f.question}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{f.answer}</p>
                </div>
                <button onClick={() => toggleFaq(f)} className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ring-inset transition ${f.isActive ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300" : "bg-slate-500/10 text-slate-500 ring-slate-500/20"}`}>
                  {f.isActive ? "نشط" : "معطل"}
                </button>
              </div>
            ))}
            <div className="grid gap-2 border-t border-line/60 pt-3 sm:grid-cols-2">
              <Input value={newFaq.question} onChange={(e) => setNewFaq((s) => ({ ...s, question: e.target.value }))} placeholder="السؤال" aria-label="السؤال" />
              <Input value={newFaq.answer} onChange={(e) => setNewFaq((s) => ({ ...s, answer: e.target.value }))} placeholder="الإجابة" aria-label="الإجابة" />
              <div className="sm:col-span-2">
                <Button size="sm" variant="secondary" onClick={addFaq}>+ إضافة سؤال</Button>
              </div>
            </div>
          </GlassCard>
        )}
      </div>
    </div>
  );
}
