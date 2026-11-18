"use client";

import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Star, Upload } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusChip } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";
import type { MediaAsset, ProductDetail } from "./model";
import { DETAIL_STRINGS as D } from "./strings";

/** «الصور»: بتنحفظ فورًا (مش جزء من حفظ الصفحة) — إضافة من المكتبة · رفع · الرئيسية · الترتيب · إزالة. */
export function ImagesTab({ product, library, onChanged }: { product: ProductDetail; library: MediaAsset[]; onChanged: () => void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const base = `/api/products/${product.id}/media`;
  const links = product.mediaLinks;
  const attached = new Set(links.map((l) => l.mediaAsset.id));

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذّر الحفظ", "error");
    }
  }

  const move = (id: string, dir: -1 | 1) => {
    const ids = links.map((l) => l.mediaAsset.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => api(base, { method: "PUT", json: { orderedMediaIds: ids } }));
  };

  async function upload(f: File) {
    const form = new FormData();
    form.append("file", f);
    form.append("category", "PRODUCT");
    form.append("productId", product.id);
    setUploading(true);
    try {
      const res = await fetch("/api/media/upload", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        toast.show(`${D.uploadFailed}${body?.message ? `: ${body.message}` : ""}`, "error");
      } else onChanged();
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="space-y-4 rounded-card border border-line bg-surface-2 p-5">
      <h3 className="text-sm font-semibold text-ink">{D.imagesTitle}</h3>
      {links.length === 0 ? (
        <p className="rounded-control bg-warning-soft px-3 py-2 text-sm text-ink">{D.imagesEmpty}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {links.map((l, i) => (
            <li key={l.mediaAsset.id} className="space-y-2 rounded-card border border-line bg-surface-3 p-2">
              {l.mediaAsset.type === "IMAGE" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.mediaAsset.url} alt={l.mediaAsset.title ?? ""} className="h-28 w-full rounded-control object-cover" loading="lazy" />
              ) : (
                <span className="flex h-28 items-center justify-center rounded-control bg-surface-2 text-xs text-ink-muted">{l.mediaAsset.type}</span>
              )}
              <div className="flex flex-wrap items-center gap-1">
                {l.isPrimary ? (
                  <StatusChip tone="info" icon={false}>
                    <Star size={11} aria-hidden /> {D.primary}
                  </StatusChip>
                ) : (
                  <Button size="sm" variant="secondary" type="button" onClick={() => void run(() => api(base, { method: "PATCH", json: { mediaAssetId: l.mediaAsset.id } }))}>
                    {D.makePrimary}
                  </Button>
                )}
                <Button size="sm" variant="ghost" type="button" disabled={i === 0} aria-label={D.moveUp} onClick={() => move(l.mediaAsset.id, -1)}>
                  <ArrowRight size={13} aria-hidden />
                </Button>
                <Button size="sm" variant="ghost" type="button" disabled={i === links.length - 1} aria-label={D.moveDown} onClick={() => move(l.mediaAsset.id, 1)}>
                  <ArrowLeft size={13} aria-hidden />
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => void run(() => api(base, { method: "DELETE", json: { mediaAssetId: l.mediaAsset.id } }))}>
                  {D.detach}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" type="button" loading={uploading} onClick={() => file.current?.click()}>
          <Upload size={14} aria-hidden /> {D.upload}
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </div>

      <details className="rounded-card border border-line bg-surface-3 p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-focus">{D.pickFromLibrary}</summary>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={D.search} aria-label={D.search} className="mt-2" />
        <ul className="mt-2 grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {library
            .filter((m) => !attached.has(m.id) && (!search || (m.title ?? "").includes(search)))
            .map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => void run(() => api(base, { method: "POST", json: { mediaAssetId: m.id } }))} className="w-full rounded-control border border-line bg-surface-2 p-1 text-xs text-ink-muted hover:border-primary focus-visible:outline-2 focus-visible:outline-focus">
                  {m.type === "IMAGE" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.url} alt="" className="h-16 w-full rounded-control object-cover" loading="lazy" />
                  ) : (
                    <span>{m.type}</span>
                  )}
                  <span className="mt-1 block truncate">{m.title ?? m.id}</span>
                </button>
              </li>
            ))}
        </ul>
      </details>
    </section>
  );
}
