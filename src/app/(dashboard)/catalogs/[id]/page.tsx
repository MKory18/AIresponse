"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";

type CatalogProduct = {
  id: string;
  product: {
    id: string;
    name: string;
    sku: string;
    price: number | string;
    currency: string;
    stockStatus: string;
    stockQty: number;
    isActive: boolean;
    isArchived: boolean;
    offers: unknown;
  };
};

type CatalogPage = {
  id: string;
  channel: { id: string; type: string; displayName: string; externalId: string | null; status: string };
};

type Detail = {
  catalog: { id: string; name: string; description: string | null; isActive: boolean };
  products: CatalogProduct[];
  pages: CatalogPage[];
};

type ChannelOption = { channelId: string; pageId: string | null; pageName: string | null; status: string };

function priceText(p: CatalogProduct["product"]): string {
  const n = typeof p.price === "number" ? p.price : Number(p.price);
  return `${Number.isFinite(n) ? n.toLocaleString("en-US") : p.price} ${p.currency}`;
}

/**
 * CATALOG DETAIL — WHAT IT IS, WHAT IT HOLDS, WHICH PAGES ANSWER WITH IT.
 *
 * Products are linked, never copied: removing one here deletes the LINK
 * row only. Prices, images, offers and stock read live from the product
 * at render time. Page links switch atomically through the same door the
 * channel screen uses.
 */
export default function CatalogDetailPage() {
  const toast = useToast();
  const routeParams = useParams<{ id: string }>();
  const id = routeParams.id;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelId, setChannelId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<{ title: string; body: string; run: () => void } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/catalogs/${id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر التحميل");
      setDetail(json);
      setName(json.catalog.name);
      setDescription(json.catalog.description ?? "");
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/channels/facebook");
      const json = await res.json().catch(() => ({}));
      if (res.ok) setChannels(json.connections ?? []);
    } catch {
      /* the assign row degrades to a manual state */
    }
  }, []);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  async function saveInfo() {
    if (!id || !name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/catalogs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر الحفظ");
      toast.show("تم الحفظ", "success");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر الحفظ", "error");
    } finally {
      setSaving(false);
    }
  }

  async function searchProducts() {
    setSearching(true);
    try {
      const res = await fetch(`/api/products?q=${encodeURIComponent(search.trim())}&limit=20`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر البحث");
      setFound(json.items ?? json.products ?? []);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر البحث", "error");
    } finally {
      setSearching(false);
    }
  }

  async function addPicked() {
    if (!id || picked.size === 0) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/catalogs/${id}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: [...picked] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر الإضافة");
      toast.show(`أُضيف ${json.added ?? 0} منتج${json.skipped ? ` (تُخطي ${json.skipped})` : ""}`, "success");
      setPickerOpen(false);
      setPicked(new Set());
      setSearch("");
      setFound([]);
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر الإضافة", "error");
    } finally {
      setAdding(false);
    }
  }

  async function removeProduct(productId: string, productName: string) {
    if (!id) return;
    try {
      const res = await fetch(`/api/catalogs/${id}/products`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر الإزالة");
      toast.show(`أُزيل «${productName}» من الكتالوج — المنتج الأصلي لم يُمس`, "success");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر الإزالة", "error");
    }
  }

  async function assign() {
    if (!id || !channelId) return;
    setAssigning(true);
    try {
      const res = await fetch(`/api/catalogs/${id}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر الربط");
      toast.show("ارتبطت الصفحة بهذا الكتالوج", "success");
      setChannelId("");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر الربط", "error");
    } finally {
      setAssigning(false);
    }
  }

  async function unassign(chId: string, pageName: string) {
    if (!id) return;
    try {
      const res = await fetch(`/api/catalogs/${id}/pages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: chId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر فك الربط");
      toast.show(`انفكت «${pageName}» — الكتالوج والمنتجات كما هي`, "success");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر فك الربط", "error");
    }
  }

  if (loading) {
    return (
      <div className="page-wrap">
        <Skeleton className="h-10 w-64 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
    );
  }

  if (failed || !detail) {
    return (
      <div className="page-wrap">
        <GlassCard className="p-2">
          <ErrorState title="تعذر التحميل" onRetry={() => void load()} />
        </GlassCard>
        <Link href="/catalogs" className="text-xs font-semibold text-brand-600 hover:underline">
          ← الكتالوجات
        </Link>
      </div>
    );
  }

  const linkedIds = new Set(detail.products.map((p) => p.product.id));

  return (
    <div className="page-wrap">
      <PageHeader
        title={detail.catalog.name}
        description={detail.catalog.description || "بلا وصف"}
        actions={
          <Link href="/catalogs" className="text-xs font-semibold text-brand-600 hover:underline">
            ← الكتالوجات
          </Link>
        }
      />
      <Badge tone={detail.catalog.isActive ? "success" : "muted"}>{detail.catalog.isActive ? "نشط" : "متوقف"}</Badge>

      <GlassCard className="mt-3 p-3">
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="اسم الكتالوج">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Field label="الوصف">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
        </div>
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => void saveInfo()} disabled={saving || !name.trim()} loading={saving}>
            احفظ
          </Button>
        </div>
      </GlassCard>

      <GlassCard className="mt-3 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-ink">المنتجات ({detail.products.length})</h2>
          <Button size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
            إضافة منتجات
          </Button>
        </div>
        {detail.products.length === 0 ? (
          <EmptyState title="كتالوج فارغ" description="أضف منتجات موجودة — لن يُنشأ منتج جديد هنا." />
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {detail.products.map(({ product: p }) => (
              <div key={p.id} className="flex items-center gap-2 rounded-2xl border border-line/60 p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-bold text-ink">{p.name}</p>
                  <p className="num mt-0.5 text-[11px] text-ink-subtle">
                    {p.sku} · {priceText(p)} · {p.stockStatus === "IN_STOCK" ? `مخزون ${p.stockQty}` : "غير متوفر"}
                    {!p.isActive || p.isArchived ? " · موقوف" : ""}
                  </p>
                </div>
                <button
                  onClick={() =>
                    setConfirmMsg({
                      title: `إزالة «${p.name}»؟`,
                      body: "فك ارتباط فقط — المنتج الأصلي وطلباته وعروضه لا تُمس.",
                      run: () => void removeProduct(p.id, p.name),
                    })
                  }
                  className="shrink-0 text-[11px] font-semibold text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  إزالة
                </button>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      <GlassCard className="mt-3 p-3">
        <h2 className="mb-2 text-sm font-bold text-ink">الصفحات المرتبطة ({detail.pages.length})</h2>
        {detail.pages.length === 0 ? (
          <EmptyState title="بلا صفحات" description="اربط صفحة ليبدأ الذكاء بالإجابة من هذا الكتالوج." />
        ) : (
          <div className="space-y-2">
            {detail.pages.map((pg) => (
              <div key={pg.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line/60 p-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-ink">{pg.channel.displayName}</p>
                  <p className="num mt-0.5 text-[11px] text-ink-subtle">
                    {pg.channel.externalId ?? ""} · {pg.channel.status}
                  </p>
                </div>
                <button
                  onClick={() =>
                    setConfirmMsg({
                      title: "فك ربط الصفحة؟",
                      body: "ستبقى الصفحة بلا كتالوج نشط حتى تُسند من جديد — الكتالوج والمنتجات كما هي.",
                      run: () => void unassign(pg.channel.id, pg.channel.displayName),
                    })
                  }
                  className="shrink-0 text-[11px] font-semibold text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  فك الربط
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="صفحة للربط" className="min-w-48 flex-1">
            <option value="">اختر صفحة ماسنجر…</option>
            {channels.map((c) => (
              <option key={c.channelId} value={c.channelId}>
                {c.pageName ?? c.pageId ?? c.channelId} · {c.status}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={assigning || !channelId}
            loading={assigning}
            onClick={() =>
              setConfirmMsg({
                title: "ربط الصفحة بهذا الكتالوج؟",
                body: "سيجيب الذكاء عن هذه الصفحة من منتجات هذا الكتالوج فقط. أي ربط سابق يُستبدل ذريًا.",
                run: () => void assign(),
              })
            }
          >
            ربط الصفحة
          </Button>
        </div>
      </GlassCard>

      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)} title="إضافة منتجات" className="max-w-lg">
        <div className="space-y-2 p-1">
          <div className="flex gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو SKU…" aria-label="بحث بالمنتجات" />
            <Button size="sm" variant="secondary" onClick={() => void searchProducts()} disabled={searching} loading={searching}>
              بحث
            </Button>
          </div>
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {found.map((p: any) => {
              const img = p.mediaLinks?.[0]?.mediaAsset?.url ?? p.image ?? null;
              const already = linkedIds.has(p.id);
              const checked = picked.has(p.id);
              return (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-2xl border border-line/60 p-2.5">
                  <input
                    type="checkbox"
                    disabled={already}
                    checked={already || checked}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setPicked(next);
                    }}
                    className="h-4 w-4 shrink-0 accent-brand-500"
                  />
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" loading="lazy" />
                  ) : (
                    <span className="h-10 w-10 shrink-0 rounded-lg bg-surface-3" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-ink">{p.name}</span>
                    <span className="num block text-[11px] text-ink-subtle">
                      {p.sku} · {p.price} {p.currency}
                      {already ? " · بالكتالوج" : ""}
                    </span>
                  </span>
                </label>
              );
            })}
            {!searching && found.length === 0 && <p className="p-2 text-xs text-ink-muted">ابحث ثم حدد منتجات متعددة دفعة واحدة.</p>}
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-muted">المحدد: {picked.size}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setPickerOpen(false)}>
                إلغاء
              </Button>
              <Button onClick={() => void addPicked()} disabled={adding || picked.size === 0} loading={adding}>
                أضف المحدد
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmMsg !== null}
        onClose={() => setConfirmMsg(null)}
        title={confirmMsg?.title ?? ""}
        body={confirmMsg?.body ?? ""}
        confirmLabel="تأكيد"
        danger
        onConfirm={() => {
          const run = confirmMsg?.run;
          setConfirmMsg(null);
          run?.();
        }}
      />
    </div>
  );
}
