"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { productSaveError } from "@/lib/product-save-error";
import { buildPatch, isDirty, toDraft, type Draft, type MediaAsset, type ProductDetail } from "./model";

/**
 * صفحة المنتج: المنتج والمكتبة بالتوازي · مسودة وحدة للأساسي و«شو بيقول الوكيل» · حفظ واحد (اللي تغيّر بس) ·
 * الصور والأسئلة الشائعة بتنحفظ فورًا (مش جزء من الحفظ) وبتعيد التحميل بلا ما تضيّع تعديل مش محفوظ.
 */
export function useProduct(id: string) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [library, setLibrary] = useState<MediaAsset[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (resetDraft: boolean) => {
      try {
        const [p, lib] = await Promise.all([api<ProductDetail>(`/api/products/${id}`), api<{ items: MediaAsset[] }>("/api/media?limit=50").catch(() => ({ items: [] as MediaAsset[] }))]);
        setProduct(p);
        setLibrary(lib.items);
        setLoadError(null);
        if (resetDraft) {
          const d = toDraft(p);
          setBase(d);
          setDraft(d);
        }
      } catch (e) {
        setLoadError(e instanceof ApiError && e.status === 404 ? "المنتج مش موجود" : e instanceof Error ? e.message : "تعذّر التحميل");
      }
    },
    [id]
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const oms = product?.oms.connected ?? false;
  const patch = useMemo(() => (draft && base ? buildPatch(draft, base, oms) : {}), [draft, base, oms]);
  const dirty = draft && base ? isDirty(draft, base, oms) : false;

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || Object.keys(patch).length === 0) return true;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/api/products/${id}`, { method: "PATCH", json: patch });
      await load(true);
      return true;
    } catch (e) {
      // السبب بالعربي جنب زر الحفظ (صلاحية · حقل طويل · رمز مكرر · خادم).
      setSaveError(e instanceof ApiError ? productSaveError(e.status, { message: e.message, error: e.code ?? undefined, details: e.details as never }) : productSaveError(0, null));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, patch, id, load]);

  const discard = useCallback(() => {
    if (base) setDraft(base);
    setSaveError(null);
  }, [base]);

  return { product, draft, setDraft, library, loadError, saveError, saving, dirty, save, discard, reload: () => load(false) };
}
