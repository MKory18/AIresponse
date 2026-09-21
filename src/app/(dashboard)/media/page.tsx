"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";
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
    const t = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(t);
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
    <div className="space-y-4">
      <h1 className="text-xl font-bold">مكتبة الوسائط</h1>

      <form ref={formRef} onSubmit={upload} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4">
        <input name="file" type="file" required accept="image/*,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,application/pdf,text/plain,text/markdown,application/json,text/csv" className="text-sm" />
        <select name="category" className={input}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input name="title" placeholder="عنوان" className={input} />
        <input name="tags" placeholder="وسوم مفصولة بفواصل" className={input} />
        <button disabled={uploading} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
          {uploading ? "جارٍ الرفع…" : "رفع"}
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث…" className={`${input} max-w-xs`} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
          <option value="">كل التصنيفات</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} className={input}>
          <option value="">كل الأنواع</option>
          {["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        {items.map((m) => (
          <div key={m.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {m.type === "IMAGE" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={m.url} alt={m.title ?? ""} className="h-28 w-full object-cover" />
            ) : (
              <div className="flex h-28 items-center justify-center bg-slate-100 text-xs text-slate-500">{m.type}</div>
            )}
            <div className="p-2">
              <p className="truncate text-xs font-medium" title={m.title ?? ""}>{m.title ?? m.id}</p>
              <p className="text-[10px] text-slate-400">{m.category} · {(m.size / 1024).toFixed(0)}KB</p>
              <button onClick={() => remove(m.id)} className="mt-1 text-[10px] text-red-600 hover:underline">حذف</button>
            </div>
          </div>
        ))}
      </div>
      {!loading && items.length === 0 && !error && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">المكتبة فارغة.</p>
      )}
    </div>
  );
}
