"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, LayoutGrid, List, Search, Trash2, Upload } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { RiskWithFix } from "@/components/integrations/ui";

type LinkedProduct = { id: string; name: string; isPrimary: boolean };

type MediaAsset = {
  id: string;
  url: string;
  type: string;
  category: string;
  title: string | null;
  size: number;
  mimeType: string;
  createdAt: string;
  products: LinkedProduct[];
  whatsapp?: { ok: boolean; reason?: string };
};

type ProductOption = { id: string; name: string };

type UploadJob = {
  key: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
  file?: File;
};

const CATEGORIES = ["PRODUCT", "FEEDBACK", "TESTIMONIAL", "BRAND", "EDUCATIONAL", "OTHER"];
const TYPE_FILTERS = [
  { key: "", label: t.media.all },
  { key: "IMAGE", label: t.media.images },
  { key: "VIDEO", label: t.media.videos },
  { key: "AUDIO", label: t.media.audios },
  { key: "DOCUMENT", label: t.media.documents },
];
const ACCEPT = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,application/pdf,text/plain,text/markdown,application/json,text/csv";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ar", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function MediaPage() {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [category, setCategory] = useState("");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [preview, setPreview] = useState<MediaAsset | null>(null);
  const [linkTarget, setLinkTarget] = useState<MediaAsset | null>(null);
  const [linkProductId, setLinkProductId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MediaAsset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (type) params.set("type", type);
    if (q) params.set("q", q);
    const res = await fetch(`/api/media?${params}`);
    if (!res.ok) {
      setError(t.media.loadFailed);
      return;
    }
    setItems((await res.json()).items);
    setError(null);
  }, [category, type, q]);

  const loadProducts = useCallback(async () => {
    const res = await fetch("/api/products?limit=100");
    if (res.ok) setProducts((await res.json()).items ?? []);
  }, []);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    for (const file of list) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setJobs((prev) => [...prev, { key, name: file.name, progress: 0, status: "uploading", file }]);
      sendFile(key, file);
    }
  }

  function sendFile(key: string, file: File) {
    const form = new FormData();
    form.append("file", file);
    form.append("category", category || "PRODUCT");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const progress = Math.round((e.loaded / e.total) * 100);
        setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, progress } : j)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, progress: 100, status: "done" } : j)));
        load();
        setTimeout(() => setJobs((prev) => prev.filter((j) => j.key !== key)), 4000);
      } else {
        // Surface the REAL server reason — never a generic message. Format:
        // "الرسالة [code=…, status=…]" so the developer sees the actual cause
        // (e.g. STORAGE_WRITE_FAILED, FILE_TOO_LARGE, 413 proxy limit).
        let detail = "";
        try {
          const data = JSON.parse(xhr.responseText);
          const msg: string = data.message ?? data.error ?? "";
          const code: string = data.error ?? "";
          detail = msg || code;
          if (code && msg && msg !== code) detail = `${msg} [code=${code}]`;
          if (!detail) detail = `HTTP ${xhr.status}`;
        } catch {
          detail = `HTTP ${xhr.status}${xhr.responseText ? ` — ${xhr.responseText.slice(0, 120)}` : ""}`;
        }
        setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, status: "error", error: `${t.media.uploadFailed}: ${detail}` } : j)));
      }
    };
    xhr.onerror = () => {
      // No HTTP response at all — network error, proxy reset (e.g. body-size
      // 413 reset), or server crash. Show a developer-readable hint.
      setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, status: "error", error: `${t.media.uploadFailed}: ما وصل رد من الخادم — غالبًا الملف أكبر من الحد المسموح بالسيرفر (NO_RESPONSE)` } : j)));
    };
    xhr.send(form);
  }

  function retryJob(job: UploadJob) {
    if (!job.file) return;
    setJobs((prev) => prev.map((j) => (j.key === job.key ? { ...j, progress: 0, status: "uploading", error: undefined } : j)));
    sendFile(job.key, job.file);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/media/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setDeleteTarget(null);
      load();
    } catch {
      setError(t.media.uploadFailed);
    } finally {
      setDeleting(false);
    }
  }

  async function confirmLink() {
    if (!linkTarget || !linkProductId) return;
    const res = await fetch(`/api/products/${linkProductId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaAssetId: linkTarget.id }),
    });
    if (res.ok) {
      setLinkTarget(null);
      setLinkProductId("");
      load();
    } else {
      setError(t.media.uploadFailed);
    }
  }

  async function unlink(assetId: string, productId: string) {
    const res = await fetch(`/api/products/${productId}/media`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaAssetId: assetId }),
    });
    if (res.ok) load();
    else setError(t.media.uploadFailed);
  }

  function renderThumb(m: MediaAsset, cls: string) {
    if (m.type === "IMAGE") {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={m.url} alt={m.title ?? ""} className={cls} loading="lazy" />;
    }
    return (
      <div className={cn(cls, "flex items-center justify-center gap-1.5 bg-surface-3/60 text-xs font-semibold text-ink-subtle")}>
        <FileUp size={16} />
        {m.type}
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <PageHeader title={t.media.title} description={t.pages.mediaDesc} />

      {/* وسائط الزبون الواردة: مؤتمتة بالكامل — أحمر مع تصحيحه بالبرتقالي. */}
      <RiskWithFix
        risk="مؤتمت: وسائط الزبون الواردة بتتحذف نهائيًا بعد 180 يوم"
        detail={
          <>
            صور الزبون ومستنداته وبصماته الصوتية الي بتوصل من واتساب <strong>ما بتظهر بهالمكتبة</strong> —
            محصورة بمحادثتها وحدها، وما بتنحشر بردود الذكاء ولا بالحملات ولا بالمنتجات ولا برابط عام.
            وبعد 180 يوم <strong>الملف بينحذف نهائيًا وما بيرجع</strong>، والرسالة بتحتفظ بعلامة «الوسيط انتهى».
          </>
        }
        fix={
          <>
            المدة بإعداد الخادم <span dir="ltr" className="num">WA_MEDIA_RETENTION_DAYS</span> (افتراضي
            <span dir="ltr" className="num"> 180</span> يوم). حطّها
            <span dir="ltr" className="num"> 0</span> إذا بدك توقّف الحذف والملفات تبقى بلا مدة —
            وإذا بدك وسيط معيّن يضل، نزّله واحفظه برا قبل ما تخلص المدة.
          </>
        }
      />

      {/* Upload zone */}
      <GlassCard className="p-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            uploadFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition",
            dragOver ? "border-brand-500 bg-brand-500/5" : "border-line/70"
          )}
        >
          <span className="glass-subtle flex h-11 w-11 items-center justify-center rounded-2xl text-brand-500">
            <Upload size={19} />
          </span>
          <p className="text-sm font-bold text-ink">{t.media.dragDrop}</p>
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
            {t.media.uploadFiles}
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {jobs.length > 0 && (
          <div className="mt-3 space-y-2">
            {jobs.map((j) => (
              <div key={j.key} className="glass-subtle rounded-xl p-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <p className="min-w-0 truncate font-bold text-ink">{j.name}</p>
                  {j.status === "uploading" && <span className="num shrink-0 text-ink-muted">{j.progress}%</span>}
                  {j.status === "done" && <span className="shrink-0 font-bold text-emerald-600 dark:text-emerald-400">{t.media.uploadOk}</span>}
                  {j.status === "error" && (
                    <button onClick={() => retryJob(j)} className="shrink-0 font-bold text-brand-600 underline underline-offset-2 dark:text-brand-300">
                      {t.delivery.retry}
                    </button>
                  )}
                </div>
                {j.status === "uploading" && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${j.progress}%` }} />
                  </div>
                )}
                {j.status === "error" && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{j.error}</p>}
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      {/* Filters */}
      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-48 flex-1">
          <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t.common.search}…`} aria-label={t.common.search} className="ps-9" />
        </div>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="التصنيف" className="w-40">
          <option value="">كل التصنيفات</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{label(c)}</option>
          ))}
        </Select>
        <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="النوع">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={type === f.key}
              onClick={() => setType(f.key)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all",
                type === f.key
                  ? "bg-primary-soft text-primary"
                  : "text-ink-muted hover:bg-surface-3 hover:text-ink"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="العرض">
          <button
            onClick={() => setView("grid")}
            aria-label={t.media.grid}
            className={cn("rounded-xl p-2 transition", view === "grid" ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink")}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => setView("list")}
            aria-label={t.media.list}
            className={cn("rounded-xl p-2 transition", view === "list" ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink")}
          >
            <List size={16} />
          </button>
        </div>
      </GlassCard>

      {error && (
        <GlassCard className="p-2">
          <EmptyState title="حدث خطأ" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}

      {loading && (
        view === "grid" ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
          </div>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
          </div>
        )
      )}

      {!loading && items.length > 0 && view === "grid" && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {items.map((m) => (
            <GlassCard key={m.id} className="group overflow-hidden p-0 transition-all duration-200 hover:border-brand-300/80 dark:hover:border-brand-700">
              <button onClick={() => setPreview(m)} className="block w-full" aria-label={t.media.preview}>
                {renderThumb(m, "h-28 w-full object-cover")}
              </button>
              <div className="space-y-1 p-2.5">
                <p className="truncate text-xs font-bold text-ink" title={m.title ?? ""}>{m.title ?? m.id}</p>
                <p className="num text-[10px] text-ink-subtle">{formatSize(m.size)} · {formatDate(m.createdAt)}</p>
                {/* A file WhatsApp would refuse says so on its own card —
                    red with its fix in orange — before anybody attaches it. */}
                {m.whatsapp && !m.whatsapp.ok && (
                  <p className="text-[10px] font-semibold leading-relaxed text-red-600 dark:text-red-400">
                    ⚠️ ما بتنبعت عالواتساب: الصيغة أو الحجم
                    <span className="block text-amber-600 dark:text-amber-400">🔧 ارفعها JPG أو PNG أقل من 5MB</span>
                  </p>
                )}
                {m.products.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {m.products.map((p) => (
                      <Badge key={p.id}>{p.name}{p.isPrimary ? " · ★" : ""}</Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-ink-subtle">{t.media.noProduct}</p>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5 text-[11px] font-medium">
                  <button onClick={() => setPreview(m)} className="text-brand-600 hover:underline dark:text-brand-300">{t.media.preview}</button>
                  <button onClick={() => setLinkTarget(m)} className="text-brand-600 hover:underline dark:text-brand-300">{t.media.linkProduct}</button>
                  <button onClick={() => setDeleteTarget(m)} className="inline-flex items-center gap-1 text-red-600 hover:text-red-700 dark:text-red-400">
                    <Trash2 size={11} />
                    {t.common.delete}
                  </button>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {!loading && items.length > 0 && view === "list" && (
        <div className="space-y-2">
          {items.map((m) => (
            <GlassCard key={m.id} className="flex flex-wrap items-center gap-3 p-3">
              <button onClick={() => setPreview(m)} aria-label={t.media.preview}>
                {renderThumb(m, "h-12 w-12 rounded-xl object-cover")}
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-ink">{m.title ?? m.id}</p>
                <p className="num mt-0.5 text-[11px] text-ink-subtle">{m.mimeType} · {formatSize(m.size)} · {formatDate(m.createdAt)}</p>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  {t.media.linkedProduct}: {m.products.length > 0 ? m.products.map((p) => p.name).join("، ") : t.media.noProduct}
                </p>
                {m.whatsapp && !m.whatsapp.ok && (
                  <p className="mt-0.5 text-[11px] font-semibold leading-relaxed text-red-600 dark:text-red-400">
                    ⚠️ ما بتنبعت عالواتساب: الصيغة أو الحجم
                    <span className="block text-amber-600 dark:text-amber-400">🔧 ارفعها JPG أو PNG أقل من 5MB</span>
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] font-medium">
                <a href={m.url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline dark:text-brand-300">{t.media.download}</a>
                <button onClick={() => setLinkTarget(m)} className="text-brand-600 hover:underline dark:text-brand-300">{t.media.linkProduct}</button>
                <button onClick={() => setDeleteTarget(m)} className="text-red-600 hover:underline dark:text-red-400">{t.common.delete}</button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <GlassCard>
          <EmptyState
            illustration="/brand/empty-media.webp"
            title={t.media.emptyTitle}
            description={t.media.emptyDesc}
            action={<Button size="sm" onClick={() => fileRef.current?.click()}>رفع صور منتجاتك</Button>}
          />
        </GlassCard>
      )}

      {/* Preview modal — shared Dialog */}
      <Dialog open={preview !== null} onClose={() => setPreview(null)} title={preview?.title ?? preview?.id ?? ""} className="max-w-2xl">
        {preview && (
          <div className="space-y-3">
            {preview.type === "IMAGE" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview.url} alt={preview.title ?? ""} width={800} height={600} className="max-h-[60vh] w-full rounded-xl object-contain" />
            ) : preview.type === "VIDEO" ? (
              <video src={preview.url} controls className="max-h-[60vh] w-full rounded-xl" />
            ) : preview.type === "AUDIO" ? (
              <audio src={preview.url} controls className="w-full" />
            ) : (
              <a href={preview.url} target="_blank" rel="noreferrer" className="block rounded-xl bg-surface-3 p-6 text-center text-sm font-bold text-brand-600 dark:text-brand-300">
                {t.media.download}
              </a>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <a href={preview.url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="secondary">{t.media.download}</Button>
              </a>
              <Button size="sm" variant="secondary" onClick={() => { setLinkTarget(preview); setPreview(null); }}>{t.media.linkProduct}</Button>
              {preview.products.map((p) => (
                <Button key={p.id} size="sm" variant="ghost" onClick={() => unlink(preview.id, p.id)} className="text-red-600 dark:text-red-400">
                  {t.media.unlink}: {p.name}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Dialog>

      {/* Link modal */}
      <Dialog open={linkTarget !== null} onClose={() => setLinkTarget(null)} title={t.media.linkProduct} className="max-w-md">
        {linkTarget && (
          <div>
            <p className="truncate text-sm text-ink-muted">{linkTarget.title ?? linkTarget.id}</p>
            <div className="mt-3">
              <Field label={t.customer.product}>
                <Select value={linkProductId} onChange={(e) => setLinkProductId(e.target.value)}>
                  <option value="">—</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="mt-4 flex justify-start gap-2">
              <Button size="sm" variant="secondary" onClick={() => setLinkTarget(null)}>{t.media.cancel}</Button>
              <Button size="sm" variant="primary" disabled={!linkProductId} onClick={confirmLink}>{t.media.linkProduct}</Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Delete dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title={t.media.deleteTitle}
        body={t.media.deleteBody}
        confirmLabel={t.media.deleteFile}
        busy={deleting}
        danger
      />
    </div>
  );
}
