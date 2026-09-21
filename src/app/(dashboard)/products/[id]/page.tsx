"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

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

const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [newFaq, setNewFaq] = useState({ question: "", answer: "" });

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

  if (error && !product) return <p className="text-sm text-red-600">{error}</p>;
  if (!product) return <p className="text-sm text-slate-400">جارٍ التحميل…</p>;

  const attachedIds = new Set(product.mediaLinks.map((l) => l.mediaAsset.id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">{product.name}</h1>
          <p className="text-xs text-slate-500" dir="ltr">{product.sku} · {product.stockStatus}</p>
        </div>
        {saved && <span className="rounded-lg bg-emerald-50 px-3 py-1 text-xs text-emerald-700">تم الحفظ ✓</span>}
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Overview */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            patchSection("overview", e.currentTarget);
          }}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <h2 className="text-sm font-bold text-slate-700">نظرة عامة</h2>
          <input name="name" defaultValue={product.name} className={input} />
          <input name="sku" defaultValue={product.sku} dir="ltr" className={input} />
          <input name="shortDescription" defaultValue={product.shortDescription ?? ""} placeholder="وصف قصير" className={input} />
          <textarea name="description" defaultValue={product.description ?? ""} placeholder="الوصف الكامل" rows={4} className={input} />
          <input name="category" defaultValue={product.category ?? ""} placeholder="التصنيف" className={input} />
          <textarea name="tags" defaultValue={product.tags.join("\n")} placeholder="الوسوم (سطر لكل وسم)" rows={2} className={input} />
          <button disabled={saving} className="rounded-lg bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50">حفظ</button>
        </form>

        {/* Pricing */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            patchSection("pricing", e.currentTarget);
          }}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <h2 className="text-sm font-bold text-slate-700">التسعير</h2>
          <label className="block text-xs text-slate-500">السعر (المصدر الوحيد للحقيقة في النظام)</label>
          <input name="price" type="number" step="0.01" min="0" defaultValue={product.price} dir="ltr" className={input} />
          <input name="compareAtPrice" type="number" step="0.01" min="0" defaultValue={product.compareAtPrice ?? ""} placeholder="السعر قبل الخصم" dir="ltr" className={input} />
          <input name="currency" defaultValue={product.currency} dir="ltr" className={input} />
          {product.variants.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold text-slate-500">الخيارات</h3>
              {product.variants.map((v) => (
                <p key={v.id} className="flex justify-between text-xs text-slate-600" dir="ltr">
                  <span>{v.name} ({v.sku})</span>
                  <span>{Number(v.price).toLocaleString()} · {v.stockQty}</span>
                </p>
              ))}
            </div>
          )}
          <button disabled={saving} className="rounded-lg bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50">حفظ</button>
        </form>

        {/* Benefits / usage / objections */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            patchSection("content", e.currentTarget);
          }}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <h2 className="text-sm font-bold text-slate-700">الفوائد والاستخدام والملاحظات</h2>
          <textarea name="benefits" defaultValue={product.benefits.join("\n")} placeholder="الفوائد (سطر لكل فائدة)" rows={3} className={input} />
          <textarea name="ingredients" defaultValue={product.ingredients ?? ""} placeholder="المكونات" rows={2} className={input} />
          <textarea name="usage" defaultValue={product.usage ?? ""} placeholder="طريقة الاستخدام" rows={2} className={input} />
          <textarea name="warnings" defaultValue={product.warnings ?? ""} placeholder="التحذيرات" rows={2} className={input} />
          <textarea name="objections" defaultValue={product.objections.join("\n")} placeholder="الاعتراضات الشائعة (سطر لكل اعتراض)" rows={2} className={input} />
          <textarea name="salesNotes" defaultValue={product.salesNotes ?? ""} placeholder="ملاحظات البيع" rows={2} className={input} />
          <button disabled={saving} className="rounded-lg bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50">حفظ</button>
        </form>

        {/* Media */}
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-bold text-slate-700">وسائط المنتج</h2>
          <div className="grid grid-cols-3 gap-2">
            {product.mediaLinks.map((link) => (
              <div key={link.mediaAsset.id} className="space-y-1 rounded-lg border border-slate-200 p-1.5 text-center">
                {link.mediaAsset.type === "IMAGE" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={link.mediaAsset.url} alt="" className="h-20 w-full rounded object-cover" />
                ) : (
                  <div className="flex h-20 items-center justify-center rounded bg-slate-100 text-xs">{link.mediaAsset.type}</div>
                )}
                {link.isPrimary && <span className="block text-[10px] text-brand-600">رئيسية ★</span>}
                <div className="flex justify-center gap-1">
                  {!link.isPrimary && (
                    <button onClick={() => setPrimary(link.mediaAsset.id)} className="rounded border border-slate-300 px-1.5 text-[10px] hover:bg-slate-50">رئيسية</button>
                  )}
                  <button onClick={() => detachMedia(link.mediaAsset.id)} className="rounded border border-red-200 px-1.5 text-[10px] text-red-600 hover:bg-red-50">إزالة</button>
                </div>
              </div>
            ))}
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-slate-500">ربط وسائط موجودة من المكتبة</summary>
            <div className="mt-2 grid max-h-52 grid-cols-3 gap-2 overflow-y-auto">
              {mediaAssets.filter((m) => !attachedIds.has(m.id)).map((m) => (
                <button key={m.id} onClick={() => attachMedia(m.id)} className="rounded border border-slate-200 p-1 text-[10px] hover:border-brand-500">
                  {m.type === "IMAGE" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.url} alt="" className="h-16 w-full rounded object-cover" />
                  ) : (
                    <span>{m.type}</span>
                  )}
                  <span className="mt-1 block truncate">{m.title ?? m.id}</span>
                </button>
              ))}
            </div>
          </details>
        </div>

        {/* FAQs */}
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-bold text-slate-700">أسئلة شائعة (بيانات منظمة — يستخدمها AI مباشرة)</h2>
          {product.faqs.map((f) => (
            <div key={f.id} className="flex items-start justify-between gap-2 rounded-lg bg-slate-50 p-2">
              <div>
                <p className="text-xs font-semibold">{f.question}</p>
                <p className="text-xs text-slate-500">{f.answer}</p>
              </div>
              <button onClick={() => toggleFaq(f)} className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${f.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                {f.isActive ? "نشط" : "معطل"}
              </button>
            </div>
          ))}
          <div className="space-y-2 border-t border-slate-100 pt-2">
            <input value={newFaq.question} onChange={(e) => setNewFaq((s) => ({ ...s, question: e.target.value }))} placeholder="السؤال" className={input} />
            <input value={newFaq.answer} onChange={(e) => setNewFaq((s) => ({ ...s, answer: e.target.value }))} placeholder="الإجابة" className={input} />
            <button onClick={addFaq} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">+ إضافة سؤال</button>
          </div>
        </div>
      </div>
    </div>
  );
}
