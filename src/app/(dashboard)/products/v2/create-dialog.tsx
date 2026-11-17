"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { productSaveError } from "@/lib/product-save-error";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { PRODUCTS_STRINGS as S } from "./strings";

/** «أضف منتج»: الحد الأدنى (اسم · رمز · سعر · عملة)، وبعد الإنشاء بنفتح صفحة المنتج لتكمّل «شو بيقول الوكيل» والصور. */
export function CreateProductDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const C = S.create;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string }>("/api/products", {
        method: "POST",
        json: {
          name: f.get("name"),
          sku: f.get("sku"),
          price: Number(f.get("price")),
          currency: String(f.get("currency") || "USD"),
          category: f.get("category") || null,
          shortDescription: f.get("shortDescription") || null,
        },
      });
      onClose();
      router.push(`/products/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : productSaveError(500, null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={C.title}>
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={C.name} className="sm:col-span-2">
          <Input name="name" required />
        </Field>
        <Field label={C.sku}>
          <Input name="sku" required dir="ltr" className="tabular-nums" />
        </Field>
        <Field label={C.price}>
          <Input name="price" required type="number" step="0.01" min="0" dir="ltr" className="tabular-nums" />
        </Field>
        <Field label={C.currency}>
          <Input name="currency" defaultValue="USD" maxLength={3} dir="ltr" className="tabular-nums" />
        </Field>
        <Field label={C.category} hint={C.optional}>
          <Input name="category" />
        </Field>
        <Field label={C.short} hint={C.optional} className="sm:col-span-2">
          <Input name="shortDescription" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger sm:col-span-2">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {C.cancel}
          </Button>
          <Button type="submit" loading={busy}>
            {C.submit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
