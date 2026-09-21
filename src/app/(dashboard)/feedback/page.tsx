"use client";

import { useCallback, useEffect, useState } from "react";

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

const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

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
    const t = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(t);
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
    await fetch(`/api/feedback/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isApproved }),
    });
    load();
  }

  async function archive(id: string) {
    await fetch(`/api/feedback/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isArchived: true }),
    });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">آراء العملاء والشهادات</h1>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
        >
          {showCreate ? "إغلاق" : "+ إضافة رأي"}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={create} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-2">
          <textarea name="content" required placeholder="نص الرأي — يُحفظ كما ورد حرفيًا (لا يُنسب لشخص لم يقله)" rows={3} className={`${input} md:col-span-2`} />
          <select name="productId" className={input}>
            <option value="">بدون منتج</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input name="source" placeholder="المصدر (مثال: واتساب — محادثة رقم 12)" className={input} />
          <input name="rating" type="number" min="1" max="5" placeholder="التقييم (1-5) اختياري" className={input} />
          <button disabled={creating} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {creating ? "جارٍ الإضافة…" : "إضافة"}
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث في النص…" className={`${input} max-w-xs`} />
        <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)} className={input}>
          <option value="">كل المنتجات</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={filterSentiment} onChange={(e) => setFilterSentiment(e.target.value)} className={input}>
          <option value="">كل المشاعر</option>
          {["positive", "negative", "neutral"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={approvedFilter} onChange={(e) => setApprovedFilter(e.target.value)} className={input}>
          <option value="">الكل</option>
          <option value="true">معتمد فقط</option>
          <option value="false">غير معتمد</option>
        </select>
      </div>

      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="space-y-3">
        {items.map((f) => (
          <div key={f.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 md:flex-row md:items-start">
            {f.media?.type === "IMAGE" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={f.media.url} alt="" className="h-20 w-20 rounded-lg object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded px-1.5 py-0.5 ${f.isApproved ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                  {f.isApproved ? "معتمد" : "بانتظار الاعتماد"}
                </span>
                {f.sentiment && (
                  <span className={`rounded px-1.5 py-0.5 ${f.sentiment === "positive" ? "bg-emerald-50 text-emerald-700" : f.sentiment === "negative" ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"}`}>
                    {f.sentiment}
                  </span>
                )}
                {f.rating && <span className="text-amber-500">{"★".repeat(f.rating)}</span>}
                {f.product && <span className="text-slate-500">📦 {f.product.name}</span>}
                {f.source && <span className="text-slate-400">· {f.source}</span>}
              </div>
              <p className="mt-2 text-sm text-slate-700">{f.content ?? "—"}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {!f.isApproved ? (
                <button onClick={() => setApproved(f.id, true)} className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50">اعتماد</button>
              ) : (
                <button onClick={() => setApproved(f.id, false)} className="rounded-lg border border-amber-300 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-50">إلغاء الاعتماد</button>
              )}
              <button onClick={() => archive(f.id)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50">أرشفة</button>
            </div>
          </div>
        ))}
      </div>
      {!loading && items.length === 0 && !error && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">لا توجد آراء.</p>
      )}
    </div>
  );
}
