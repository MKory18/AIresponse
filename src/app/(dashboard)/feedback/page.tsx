"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Package, Plus, Star } from "lucide-react";
import { t, formatNumber, label } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";

type FeedbackItem = {
  id: string;
  kind: string;
  content: string | null;
  sentiment: string | null;
  rating: number | null;
  source: string | null;
  isApproved: boolean;
  isArchived: boolean;
  product: { id: string; name: string } | null;
  media: { url: string; type: string } | null;
};

export default function FeedbackPage() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [filterProduct, setFilterProduct] = useState("");
  const [filterSentiment, setFilterSentiment] = useState("");
  const [approvedFilter, setApprovedFilter] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<FeedbackItem | null>(null);

  useEffect(() => {
    fetch("/api/products?limit=100").then(async (res) => {
      if (res.ok) setProducts((await res.json()).items);
    });
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterProduct) params.set("productId", filterProduct);
    if (filterSentiment) params.set("sentiment", filterSentiment);
    if (approvedFilter) params.set("approved", approvedFilter);
    if (q) params.set("q", q);
    const res = await fetch(`/api/feedback?${params}`);
    if (!res.ok) {
      setError("فشل تحميل الآراء");
      return;
    }
    setItems((await res.json()).items);
    setError(null);
  }, [filterProduct, filterSentiment, approvedFilter, q]);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setCreating(true);
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: form.get("content"),
        productId: form.get("productId") || null,
        source: form.get("source") || null,
        rating: form.get("rating") ? Number(form.get("rating")) : null,
        kind: "TEXT",
      }),
    });
    setCreating(false);
    if (res.ok) {
      setShowCreate(false);
      load();
    } else {
      const data = await res.json();
      setError(data.message ?? "فشل الإضافة");
    }
  }

  async function setApproved(id: string, isApproved: boolean) {
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isApproved }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setError("فشل تحديث حالة الرأي");
    }
    load();
  }

  async function archive(id: string) {
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: true }),
      });
      if (!res.ok) throw new Error();
      setArchiveTarget(null);
    } catch {
      setError("فشل الأرشفة");
    }
    load();
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title={t.pages.feedbackTitle}
        description={t.pages.feedbackDesc}
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> إضافة رأي
          </Button>
        }
      />

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <div className="min-w-44 flex-1">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث في النص…" aria-label={t.common.search} />
        </div>
        <Select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} aria-label="المنتج" className="w-44">
          <option value="">كل المنتجات</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
        <Select value={filterSentiment} onChange={(e) => setFilterSentiment(e.target.value)} aria-label="المشاعر" className="w-36">
          <option value="">كل المشاعر</option>
          {["positive", "negative", "neutral"].map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </Select>
        <Select value={approvedFilter} onChange={(e) => setApprovedFilter(e.target.value)} aria-label="الاعتماد" className="w-36">
          <option value="">الكل</option>
          <option value="true">معتمد فقط</option>
          <option value="false">غير معتمد</option>
        </Select>
      </GlassCard>

      {error && (
        <GlassCard className="p-2">
          <EmptyState title="حدث خطأ" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}
      {loading && (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
      )}

      {!loading && (
        <div className="space-y-2.5">
          {items.map((f) => (
            <GlassCard key={f.id} className="flex flex-col gap-3 p-4 transition-colors hover:border-brand-300/80 dark:hover:border-brand-700 md:flex-row md:items-start">
              {f.media?.type === "IMAGE" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.media.url} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover" loading="lazy" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge tone={f.isApproved ? "DELIVERED" : "CONFIRMATION_PENDING"} dot>
                    {f.isApproved ? "معتمد" : "بانتظار الاعتماد"}
                  </Badge>
                  {f.sentiment && (
                    <Badge tone={f.sentiment === "positive" ? "DELIVERED" : f.sentiment === "negative" ? "FAILED" : "NORMAL"}>
                      {label(f.sentiment)}
                    </Badge>
                  )}
                  {f.rating != null && (
                    <span className="inline-flex items-center gap-0.5 text-amber-500" aria-label={`تقييم ${f.rating} من 5`}>
                      {Array.from({ length: f.rating }).map((_, i) => <Star key={i} size={12} fill="currentColor" />)}
                    </span>
                  )}
                  {f.product && (
                    <span className="inline-flex items-center gap-1 text-ink-muted">
                      <Package size={12} /> {f.product.name}
                    </span>
                  )}
                  {f.source && <span className="text-ink-subtle">· {f.source}</span>}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-ink">{f.content ?? "—"}</p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {!f.isApproved ? (
                  <Button size="sm" variant="success" onClick={() => setApproved(f.id, true)}>اعتماد</Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setApproved(f.id, false)}>إلغاء الاعتماد</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setArchiveTarget(f)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">أرشفة</Button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
      {!loading && items.length === 0 && !error && (
        <GlassCard>
          <EmptyState
            icon={<MessageCircle size={28} strokeWidth={1.5} />}
            title="لا توجد آراء"
            description="أضف أول رأي لعميل لعرضه هنا."
            action={<Button size="sm" onClick={() => setShowCreate(true)}>إضافة رأي</Button>}
          />
        </GlassCard>
      )}

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="إضافة رأي">
        <form onSubmit={create} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="نص الرأي" hint="يُحفظ كما ورد حرفيًا — لا يُنسب لشخص لم يقله." className="sm:col-span-2">
            <Textarea name="content" required rows={3} placeholder="نص الرأي…" />
          </Field>
          <Field label="المنتج">
            <Select name="productId" defaultValue="">
              <option value="">بدون منتج</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="المصدر">
            <Input name="source" placeholder="مثال: محادثة رقم 12" />
          </Field>
          <Field label="التقييم (1-5)">
            <Input name="rating" type="number" min="1" max="5" dir="ltr" className="num" />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>{t.common.cancel}</Button>
            <Button type="submit" loading={creating}>إضافة</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => archiveTarget && void archive(archiveTarget.id)}
        title="أرشفة هذا الرأي؟"
        body="سيختفي من قوائم الآراء المعروضة. يمكن الرجوع عنه من قاعدة البيانات فقط."
        confirmLabel="أرشفة"
        danger
      />
    </div>
  );
}
