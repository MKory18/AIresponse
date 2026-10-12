"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  products: number;
  pages: number;
  updatedAt: string;
};

/**
 * كتالوجات المنتجات — WHICH PRODUCTS EACH PAGE MAY ANSWER WITH.
 *
 * A catalog is a named set of this workspace's products. Each Facebook
 * page carries exactly one active catalog; the AI answers that page from
 * its catalog only. Creating, editing, activating and deleting happen
 * here; the per-page link lives on the channel (see CatalogPageSection)
 * and inside each catalog's detail page.
 */
export default function CatalogsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("updated");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CatalogRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("isActive", status === "active" ? "true" : "false");
      params.set("sort", sort);
      const res = await fetch(`/api/catalogs?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر التحميل");
      setRows(json.catalogs ?? []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [q, status, sort]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/catalogs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر الإنشاء");
      setCreateOpen(false);
      setName("");
      setDescription("");
      toast.show("أُنشئ الكتالوج", "success");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر الإنشاء", "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(row: CatalogRow) {
    // Deactivating the catalog a live page answers with is said out loud:
    // the page keeps its link but the AI stops using it.
    setToggling(row.id);
    try {
      const res = await fetch(`/api/catalogs/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر الحفظ");
      toast.show(row.isActive ? "أُوقف الكتالوج" : "فُعّل الكتالوج", "success");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر الحفظ", "error");
    } finally {
      setToggling(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      const res = await fetch(`/api/catalogs/${deleting.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "تعذر الحذف");
      toast.show("حُذف الكتالوج — المنتجات نفسها لم تُمس", "success");
      setDeleting(null);
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذر الحذف", "error");
    }
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title="كتالوجات المنتجات"
        description="مجموعات المنتجات التي تجيب عنها كل صفحة — تُنشأ هنا وتُربط بالصفحات من هنا أو من صفحة القناة."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            إنشاء كتالوج جديد
          </Button>
        }
      />

      <GlassCard level="glass-subtle" className="flex flex-wrap items-center gap-2 p-3">
        <div className="min-w-48 flex-1">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث بالاسم…" aria-label="بحث بالاسم" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة" className="w-36">
          <option value="">كل الحالات</option>
          <option value="active">نشط</option>
          <option value="inactive">متوقف</option>
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="الترتيب" className="w-40">
          <option value="updated">الأحدث تحديثًا</option>
          <option value="name">الاسم</option>
        </Select>
      </GlassCard>

      {failed && (
        <GlassCard className="p-2">
          <ErrorState title="تعذر التحميل" onRetry={() => void load()} />
        </GlassCard>
      )}

      {loading && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      )}

      {!loading && !failed && rows !== null && rows.length === 0 && (
        <EmptyState title="لا كتالوجات بعد" description="أنشئ أول كتالوج واربطه بصفحة ليجيب الذكاء منه." />
      )}

      {!loading && !failed && rows !== null && rows.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => (
            <GlassCard key={c.id} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/catalogs/${c.id}`} className="truncate text-sm font-bold text-ink hover:text-brand-600 hover:underline">
                    {c.name}
                  </Link>
                  {c.description && <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{c.description}</p>}
                </div>
                <Badge tone={c.isActive ? "success" : "muted"}>{c.isActive ? "نشط" : "متوقف"}</Badge>
              </div>
              <p className="num mt-2 text-[11px] text-ink-subtle">
                {c.products} منتج · {c.pages} صفحات
              </p>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] font-medium">
                <Link href={`/catalogs/${c.id}`} className="text-brand-600 hover:underline dark:text-brand-300">
                  التفاصيل
                </Link>
                <button
                  onClick={() => void toggleActive(c)}
                  disabled={toggling === c.id}
                  className="text-brand-600 hover:underline disabled:opacity-50 dark:text-brand-300"
                >
                  {c.isActive ? "إيقاف" : "تفعيل"}
                </button>
                <button onClick={() => setDeleting(c)} className="text-red-600 hover:text-red-700 dark:text-red-400">
                  حذف
                </button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="إنشاء كتالوج جديد" className="max-w-md">
        <div className="space-y-3 p-1">
          <Field label="اسم الكتالوج">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: صحة بلس" maxLength={80} />
          </Field>
          <Field label="الوصف (اختياري)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="لأي صفحات هذا الكتالوج؟" maxLength={500} />
          </Field>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            بعد الإنشاء: أضف المنتجات واربط الصفحات من صفحة التفاصيل.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={() => void create()} disabled={saving || !name.trim()} loading={saving}>
              إنشاء
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`حذف «${deleting?.name ?? ""}»؟`}
        body="سيُحذف الكتالوج وروابطه بالصفحات. المنتجات الأصلية والطلبات والعروض لا تُمس أبدًا."
        confirmLabel="احذف الكتالوج"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  );
}
