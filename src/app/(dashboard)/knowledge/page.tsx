"use client";

import { useCallback, useEffect, useState } from "react";

type Doc = {
  id: string;
  title: string;
  category: string;
  status: string;
  version: number;
  error: string | null;
  createdAt: string;
};

type Faq = { id: string; question: string; answer: string; category: string | null; isActive: boolean };

const STATUS_STYLES: Record<string, string> = {
  READY: "bg-emerald-50 text-emerald-700",
  PROCESSING: "bg-amber-50 text-amber-700",
  UPLOADING: "bg-amber-50 text-amber-700",
  FAILED: "bg-red-50 text-red-600",
  ARCHIVED: "bg-slate-100 text-slate-500",
};

const CATEGORIES = ["POLICY", "DELIVERY", "PAYMENT", "COMPANY", "PRODUCT", "FAQ", "DOCUMENT", "CUSTOM"];
const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

export default function KnowledgePage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFaq, setNewFaq] = useState({ question: "", answer: "", category: "" });

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    const [docsRes, faqsRes] = await Promise.all([
      fetch(`/api/knowledge?${params}`),
      fetch("/api/faqs?limit=200"),
    ]);
    if (!docsRes.ok || !faqsRes.ok) {
      setError("فشل تحميل قاعدة المعرفة");
      return;
    }
    setDocs((await docsRes.json()).items);
    setFaqs((await faqsRes.json()).items);
    setError(null);
  }, [status, category]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function createDoc(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setCreating(true);
    const res = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        content: form.get("content"),
        category: form.get("category"),
        sourceType: "MANUAL",
      }),
    });
    setCreating(false);
    if (res.ok) {
      (e.target as HTMLFormElement).reset();
      load();
    } else {
      const data = await res.json();
      setError(data.message ?? "فشل الإنشاء");
    }
  }

  async function reprocess(id: string) {
    // PATCH without content change just re-enqueues processing when needed;
    // re-archive/reactivate triggers chunk refresh.
    await fetch(`/api/knowledge/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    load();
  }

  async function archive(id: string) {
    await fetch(`/api/knowledge/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    load();
  }

  async function addFaq() {
    if (!newFaq.question.trim() || !newFaq.answer.trim()) return;
    await fetch("/api/faqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...newFaq, category: newFaq.category || null }),
    });
    setNewFaq({ question: "", answer: "", category: "" });
    load();
  }

  async function toggleFaq(f: Faq) {
    await fetch(`/api/faqs/${f.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !f.isActive }),
    });
    load();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">قاعدة المعرفة</h1>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {/* Documents */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold text-slate-700">المستندات</h2>
        <form onSubmit={createDoc} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-3">
          <input name="title" required placeholder="عنوان المستند" className={input} />
          <select name="category" className={input}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button disabled={creating} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {creating ? "جارٍ الإرسال…" : "إضافة (تتم المعالجة في الخلفية)"}
          </button>
          <textarea name="content" required placeholder="الصق نص المستند هنا…" rows={4} className={`${input} md:col-span-3`} />
        </form>

        <div className="flex gap-2">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${input} max-w-40`}>
            <option value="">كل الحالات</option>
            {Object.keys(STATUS_STYLES).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${input} max-w-40`}>
            <option value="">كل التصنيفات</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        {loading && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{d.title}</p>
                <p className="text-xs text-slate-500">{d.category} · إصدار {d.version}</p>
                {d.error && <p className="text-xs text-red-600">{d.error}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[d.status]}`}>{d.status}</span>
                {d.status === "FAILED" && (
                  <button onClick={() => reprocess(d.id)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">إعادة المحاولة</button>
                )}
                {d.status !== "ARCHIVED" && (
                  <button onClick={() => archive(d.id)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50">أرشفة</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQs */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold text-slate-700">الأسئلة الشائعة العامة</h2>
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-4">
          <input value={newFaq.question} onChange={(e) => setNewFaq((s) => ({ ...s, question: e.target.value }))} placeholder="السؤال" className={input} />
          <input value={newFaq.answer} onChange={(e) => setNewFaq((s) => ({ ...s, answer: e.target.value }))} placeholder="الإجابة" className={input} />
          <input value={newFaq.category} onChange={(e) => setNewFaq((s) => ({ ...s, category: e.target.value }))} placeholder="التصنيف" className={input} />
          <button onClick={addFaq} className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50">+ إضافة</button>
        </div>
        <div className="space-y-2">
          {faqs.map((f) => (
            <div key={f.id} className="flex items-start justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
              <div>
                <p className="text-sm font-semibold">{f.question}</p>
                <p className="text-xs text-slate-500">{f.answer}</p>
                {f.category && <span className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{f.category}</span>}
              </div>
              <button onClick={() => toggleFaq(f)} className={`shrink-0 rounded px-2 py-0.5 text-[10px] ${f.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                {f.isActive ? "نشط" : "معطل"}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
