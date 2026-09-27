"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Images, Search, Trash2, Upload } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type MediaAsset = {
  id: string;
  url: string;
  type: string;
  category: string;
  title: string | null;
  size: number;
  mimeType: string;
  createdAt: string;
};

const CATEGORIES = ["PRODUCT", "FEEDBACK", "TESTIMONIAL", "BRAND", "EDUCATIONAL", "OTHER"];

export default function MediaPage() {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [category, setCategory] = useState("");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (type) params.set("type", type);
    if (q) params.set("q", q);
    const res = await fetch(`/api/media?${params}`);
    if (!res.ok) {
      setError("فشل تحميل المكتبة");
      return;
    }
    setItems((await res.json()).items);
    setError(null);
  }, [category, type, q]);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setUploading(true);
    const res = await fetch("/api/media/upload", { method: "POST", body: form });
    setUploading(false);
    if (res.ok) {
      formRef.current?.reset();
      load();
    } else {
      const data = await res.json();
      setError(data.message ?? data.details ?? "فشل الرفع");
    }
  }

  async function remove(id: string) {
    await fetch(`/api/media/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="page-wrap">
      <PageHeader title={t.pages.mediaTitle} description={t.pages.mediaDesc} />

      <GlassCard className="p-4">
        <form ref={formRef} onSubmit={upload} className="flex flex-wrap items-end gap-2.5">
          <Field label="الملف" className="min-w-48 flex-1">
            <Input name="file" type="file" required accept="image/*,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,application/pdf,text/plain,text/markdown,application/json,text/csv" className="cursor-pointer pt-1.5" />
          </Field>
          <Field label="التصنيف" className="w-36">
            <Select name="category" defaultValue="PRODUCT">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="عنوان" className="w-40">
            <Input name="title" placeholder="اختياري" />
          </Field>
          <Field label="وسوم" className="w-44">
            <Input name="tags" placeholder="وسوم مفصولة بفواصل" />
          </Field>
          <Button type="submit" loading={uploading} disabled={uploading}>
            <Upload size={14} />
            {uploading ? "جارٍ الرفع…" : "رفع"}
          </Button>
        </form>
      </GlassCard>

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-48 flex-1">
          <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t.common.search}…`} aria-label={t.common.search} className="ps-9" />
        </div>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="التصنيف" className="w-40">
          <option value="">كل التصنيفات</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="النوع" className="w-36">
          <option value="">كل الأنواع</option>
          {["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"].map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </Select>
      </GlassCard>

      {error && (
        <GlassCard className="p-2">
          <EmptyState title="حدث خطأ" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}

      {loading && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {items.map((m) => (
            <GlassCard key={m.id} className="group overflow-hidden p-0 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glass">
              {m.type === "IMAGE" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt={m.title ?? ""} className="h-28 w-full object-cover" loading="lazy" />
              ) : (
                <div className="flex h-28 items-center justify-center gap-1.5 bg-surface-3/60 text-xs font-semibold text-ink-subtle">
                  <FileUp size={16} />
                  {m.type}
                </div>
              )}
              <div className="p-2.5">
                <p className="truncate text-xs font-bold text-ink" title={m.title ?? ""}>{m.title ?? m.id}</p>
                <p className="num mt-0.5 text-[10px] text-ink-subtle">{m.category} · {(m.size / 1024).toFixed(0)}KB</p>
                <button onClick={() => remove(m.id)} className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-red-600 transition hover:text-red-700 dark:text-red-400">
                  <Trash2 size={11} />
                  {t.common.delete}
                </button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
      {!loading && items.length === 0 && !error && (
        <GlassCard>
          <EmptyState icon={<Images size={28} strokeWidth={1.5} />} title="المكتبة فارغة" description="ارفع أول ملف لاستخدامه في المنتجات والمحادثات." />
        </GlassCard>
      )}
    </div>
  );
}
