"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Product = {
  id: string;
  name: string;
  sku: string;
  price: string;
  compareAtPrice: string | null;
  currency: string;
  stockStatus: string;
  category: string | null;
  isActive: boolean;
  isArchived: boolean;
  mediaLinks: { mediaAsset: { url: string; type: string } }[];
};

const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    const res = await fetch(`/api/products?${params}`);
    if (!res.ok) {
      setError("فشل تحميل المنتجات");
      return;
    }
    const data = await res.json();
    setProducts(data.items);
    setError(null);
  }, [q, status]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function createProduct(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    const form = new FormData(e.currentTarget);
    const payload = {
      name: form.get("name"),
      sku: form.get("sku"),
      price: Number(form.get("price")),
      currency: form.get("currency") || "USD",
      category: form.get("category") || null,
      shortDescription: form.get("shortDescription") || null,
    };
    const res = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setCreating(false);
    if (res.ok) {
      setShowCreate(false);
      formRef.current?.reset();
      load();
    } else {
      const data = await res.json();
      setError(data.message ?? "فشل إنشاء المنتج");
    }
  }

  async function toggleArchive(p: Product) {
    await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p.isArchived ? { isArchived: false } : { isArchived: true }),
    });
    load();
  }

  async function toggleActive(p: Product) {
    await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">المنتجات</h1>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
        >
          {showCreate ? "إغلاق" : "+ منتج جديد"}
        </button>
      </div>

      {showCreate && (
        <form ref={formRef} onSubmit={createProduct} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-3">
          <input name="name" required placeholder="اسم المنتج" className={input} />
          <input name="sku" required placeholder="SKU" dir="ltr" className={input} />
          <input name="price" required type="number" step="0.01" min="0" placeholder="السعر" className={input} />
          <input name="currency" defaultValue="USD" placeholder="العملة" dir="ltr" className={input} />
          <input name="category" placeholder="التصنيف" className={input} />
          <input name="shortDescription" placeholder="وصف قصير" className={input} />
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 md:col-span-3"
          >
            {creating ? "جارٍ الإنشاء..." : "إنشاء المنتج"}
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث بالاسم أو SKU أو الوسم…" className={`${input} max-w-xs`} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${input} max-w-40`}>
          <option value="active">النشطة</option>
          <option value="inactive">غير النشطة</option>
          <option value="archived">المؤرشفة</option>
          <option value="all">الكل</option>
        </select>
      </div>

      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {products.map((p) => {
          const primary = p.mediaLinks[0]?.mediaAsset;
          return (
            <div key={p.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
              {primary?.type === "IMAGE" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={primary.url} alt={p.name} className="mb-3 h-36 w-full rounded-lg object-cover" />
              ) : (
                <div className="mb-3 flex h-36 w-full items-center justify-center rounded-lg bg-slate-100 text-slate-400">لا توجد صورة</div>
              )}
              <Link href={`/products/${p.id}`} className="text-sm font-bold text-slate-800 hover:text-brand-600">
                {p.name}
              </Link>
              <p className="mt-0.5 text-xs text-slate-500" dir="ltr">{p.sku}</p>
              <div className="mt-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-brand-600" dir="ltr">
                  {Number(p.price).toLocaleString()} {p.currency}
                </p>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${p.isArchived ? "bg-slate-100 text-slate-500" : p.isActive ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                  {p.isArchived ? "مؤرشف" : p.isActive ? "نشط" : "غير نشط"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <button onClick={() => toggleActive(p)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">
                  {p.isActive ? "تعطيل" : "تفعيل"}
                </button>
                <button onClick={() => toggleArchive(p)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50">
                  {p.isArchived ? "استعادة" : "أرشفة"}
                </button>
                <Link href={`/products/${p.id}`} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">
                  تفاصيل
                </Link>
              </div>
            </div>
          );
        })}
      </div>
      {!loading && products.length === 0 && !error && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">لا توجد منتجات.</p>
      )}
    </div>
  );
}
