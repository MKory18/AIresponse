"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, FileText, MessageCircleQuestion, Plus } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

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

const DOC_TONE: Record<string, string> = {
  READY: "DELIVERED",
  PROCESSING: "CONFIRMATION_PENDING",
  UPLOADING: "CONFIRMATION_PENDING",
  FAILED: "FAILED",
  ARCHIVED: "CLOSED",
};

const CATEGORIES = ["POLICY", "DELIVERY", "PAYMENT", "COMPANY", "PRODUCT", "FAQ", "DOCUMENT", "CUSTOM"];

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
    <div className="page-wrap">
      <PageHeader title={t.pages.knowledgeTitle} description={t.pages.knowledgeDesc} />
      {error && (
        <GlassCard className="p-2">
          <EmptyState title="حدث خطأ" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}

      {/* Documents */}
      <GlassCard className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <FileText size={15} />
          </span>
          المستندات
        </h2>
        <form onSubmit={createDoc} className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
          <Field label="عنوان المستند">
            <Input name="title" required placeholder="مثال: سياسة الإرجاع" />
          </Field>
          <Field label="التصنيف">
            <Select name="category" defaultValue="POLICY">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{label(c) ?? c}</option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" loading={creating} disabled={creating} className="w-full md:w-auto">
              <Plus size={14} />
              {creating ? "جارٍ الإرسال…" : "إضافة (تتم المعالجة في الخلفية)"}
            </Button>
          </div>
          <Field label="نص المستند" className="md:col-span-3">
            <Textarea name="content" required placeholder="الصق نص المستند هنا…" rows={4} />
          </Field>
        </form>

        <div className="flex flex-wrap gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.common.status} className="w-40">
            <option value="">كل الحالات</option>
            {Object.keys(DOC_TONE).map((s) => (
              <option key={s} value={s}>{label(s) ?? s}</option>
            ))}
          </Select>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="التصنيف" className="w-40">
            <option value="">كل التصنيفات</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </div>

        {loading && (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
          </div>
        )}
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="glass-subtle flex flex-wrap items-center justify-between gap-2 rounded-xl p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">{d.title}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{label(d.category) ?? d.category} · إصدار <span className="num">{d.version}</span></p>
                {d.error && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{d.error}</p>}
              </div>
              <div className="flex items-center gap-1.5">
                <Badge tone={DOC_TONE[d.status]} dot>{label(d.status) ?? d.status}</Badge>
                {d.status === "FAILED" && (
                  <Button size="sm" variant="secondary" onClick={() => reprocess(d.id)}>{t.common.retry}</Button>
                )}
                {d.status !== "ARCHIVED" && (
                  <Button size="sm" variant="ghost" onClick={() => archive(d.id)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">أرشفة</Button>
                )}
              </div>
            </div>
          ))}
        </div>
        {!loading && docs.length === 0 && (
          <EmptyState icon={<BookOpen size={26} strokeWidth={1.5} />} title="لا توجد مستندات" description="أضف أول مستند ليتعلّم منه الذكاء الاصطناعي." />
        )}
      </GlassCard>

      {/* FAQs */}
      <GlassCard className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
            <MessageCircleQuestion size={15} />
          </span>
          الأسئلة الشائعة العامة
        </h2>
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-4">
          <Input value={newFaq.question} onChange={(e) => setNewFaq((s) => ({ ...s, question: e.target.value }))} placeholder="السؤال" aria-label="السؤال" />
          <Input value={newFaq.answer} onChange={(e) => setNewFaq((s) => ({ ...s, answer: e.target.value }))} placeholder="الإجابة" aria-label="الإجابة" />
          <Input value={newFaq.category} onChange={(e) => setNewFaq((s) => ({ ...s, category: e.target.value }))} placeholder="التصنيف" aria-label="التصنيف" />
          <Button variant="secondary" onClick={addFaq}><Plus size={14} /> إضافة</Button>
        </div>
        <div className="space-y-2">
          {faqs.map((f) => (
            <div key={f.id} className="glass-subtle flex items-start justify-between gap-2 rounded-xl p-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink">{f.question}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{f.answer}</p>
                {f.category && <Badge className="mt-1.5">{f.category}</Badge>}
              </div>
              <button onClick={() => toggleFaq(f)} className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ring-inset transition ${f.isActive ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300" : "bg-slate-500/10 text-slate-500 ring-slate-500/20"}`}>
                {f.isActive ? "نشط" : "معطل"}
              </button>
            </div>
          ))}
        </div>
      </GlassCard>
    </div>
  );
}
