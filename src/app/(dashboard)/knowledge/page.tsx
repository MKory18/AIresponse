"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, FlaskConical, MessageCircleQuestion, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Doc = {
  id: string;
  title: string;
  category: string;
  status: string;
  version: number;
  error: string | null;
  chunkCount?: number;
  createdAt: string;
  updatedAt: string;
};

type Chunk = { id: string; content: string; chunkIndex: number };

type Faq = { id: string; question: string; answer: string; category: string | null; isActive: boolean };

type SearchHit = {
  chunkId: string;
  documentId: string;
  documentTitle: string | null;
  documentCategory: string | null;
  score: number;
  preview: string;
  content: string;
};

const DOC_TONE: Record<string, string> = {
  READY: "DELIVERED",
  PROCESSING: "CONFIRMATION_PENDING",
  UPLOADING: "CONFIRMATION_PENDING",
  FAILED: "FAILED",
  ARCHIVED: "CLOSED",
};

const CATEGORIES = ["POLICY", "DELIVERY", "PAYMENT", "COMPANY", "PRODUCT", "FAQ", "DOCUMENT", "CUSTOM"];

function statusLabel(status: string): string {
  if (status === "PROCESSING") return t.knowledge.processing;
  if (status === "READY") return t.knowledge.indexed;
  if (status === "FAILED") return t.knowledge.failed;
  return label(status) ?? status;
}

export default function KnowledgePage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [newFaq, setNewFaq] = useState({ question: "", answer: "", category: "" });
  const [editing, setEditing] = useState<Doc | null>(null);
  const [editForm, setEditForm] = useState({ title: "", content: "", category: "CUSTOM" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleting, setDeleting] = useState<Doc | null>(null);
  const [detail, setDetail] = useState<{ doc: Doc; chunks: Chunk[] } | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    if (q) params.set("q", q);
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
  }, [status, category, q]);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => load().finally(() => setLoading(false)), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

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

  async function uploadFile(file: File) {
    const form = new FormData();
    form.append("file", file);
    setUploadingFile(true);
    const res = await fetch("/api/knowledge/upload", { method: "POST", body: form });
    setUploadingFile(false);
    if (res.ok) load();
    else {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل الرفع");
    }
  }

  async function reindex(id: string) {
    await fetch(`/api/knowledge/${id}/reindex`, { method: "POST" });
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

  async function confirmDelete() {
    if (!deleting) return;
    const res = await fetch(`/api/knowledge/${deleting.id}`, { method: "DELETE" });
    if (res.ok) {
      setDeleting(null);
      load();
    } else {
      setError("فشل الحذف");
    }
  }

  function openEdit(d: Doc) {
    setEditing(d);
    setEditForm({ title: d.title, content: "", category: d.category });
  }

  async function saveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    const body: Record<string, unknown> = { title: editForm.title, category: editForm.category };
    if (editForm.content.trim()) body.content = editForm.content;
    const res = await fetch(`/api/knowledge/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSavingEdit(false);
    if (res.ok) {
      setEditing(null);
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل الحفظ");
    }
  }

  async function openDetail(d: Doc) {
    const res = await fetch(`/api/knowledge/${d.id}`);
    if (res.ok) {
      const data = await res.json();
      setDetail({ doc: d, chunks: data.chunks ?? [] });
    }
  }

  async function runSearch() {
    if (!searchQ.trim()) return;
    setSearching(true);
    setHits(null);
    const res = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: searchQ, limit: 5 }),
    });
    setSearching(false);
    if (res.ok) setHits((await res.json()).items);
    else setHits([]);
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
      <PageHeader title={t.knowledge.title} description={t.pages.knowledgeDesc} />
      {error && (
        <GlassCard className="p-2">
          <EmptyState title="حدث خطأ" description={error} action={<Button size="sm" variant="secondary" onClick={load}>{t.common.retry}</Button>} />
        </GlassCard>
      )}

      {/* Add source */}
      <GlassCard className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <Plus size={15} />
          </span>
          {t.knowledge.addSource}
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
              {creating ? "جارٍ الإرسال…" : `${t.knowledge.fromText}`}
            </Button>
          </div>
          <Field label="نص المستند" className="md:col-span-3">
            <Textarea name="content" required placeholder="الصق نص المستند هنا…" rows={4} />
          </Field>
        </form>
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
          <span className="text-xs font-bold text-ink-muted">{t.knowledge.fromFile} (PDF/TXT/MD/CSV/JSON):</span>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-surface-3 px-3 py-1.5 text-xs font-bold text-ink transition hover:bg-surface-3/70">
            <Upload size={13} />
            {uploadingFile ? "جارٍ الرفع…" : t.knowledge.uploadFile}
            <input
              type="file"
              accept=".pdf,.txt,.md,.csv,.json,application/pdf,text/plain,text/markdown,application/json,text/csv"
              className="hidden"
              disabled={uploadingFile}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t.common.search}…`} aria-label={t.common.search} className="min-w-48 flex-1" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t.common.status} className="w-40">
            <option value="">كل الحالات</option>
            {Object.keys(DOC_TONE).map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </Select>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="التصنيف" className="w-40">
            <option value="">كل التصنيفات</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{label(c)}</option>
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
              <button onClick={() => openDetail(d)} className="min-w-0 flex-1 text-start" aria-label={t.knowledge.open}>
                <p className="truncate text-sm font-bold text-ink">{d.title}</p>
                <p className="num mt-0.5 text-xs text-ink-muted">
                  {label(d.category) ?? d.category} · إصدار <span className="num">{d.version}</span> · {d.chunkCount ?? 0} {t.knowledge.chunkCount}
                </p>
                {d.error && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{d.error}</p>}
              </button>
              <div className="flex items-center gap-1.5">
                <Badge tone={DOC_TONE[d.status]} dot>{statusLabel(d.status)}</Badge>
                {(d.status === "FAILED" || d.status === "READY") && (
                  <Button size="sm" variant="secondary" onClick={() => reindex(d.id)}>{t.knowledge.reindex}</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => openEdit(d)} aria-label={t.knowledge.edit}>
                  <Pencil size={13} />
                </Button>
                {d.status !== "ARCHIVED" && (
                  <Button size="sm" variant="ghost" onClick={() => archive(d.id)} className="text-amber-600 hover:bg-amber-500/10 dark:text-amber-400">أرشفة</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setDeleting(d)} aria-label={t.knowledge.delete} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
          ))}
        </div>
        {!loading && docs.length === 0 && (
          <EmptyState
            icon={<BookOpen size={26} strokeWidth={1.5} />}
            title={t.knowledge.emptyTitle}
            description={t.knowledge.emptyDesc}
            action={
              <Button size="sm" variant="secondary" onClick={() => document.getElementById("faqs")?.scrollIntoView({ behavior: "smooth" })}>
                أسرع بداية: سؤال شائع
              </Button>
            }
          />
        )}
      </GlassCard>

      {/* Search test */}
      <GlassCard className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
            <FlaskConical size={15} />
          </span>
          {t.knowledge.testSearch}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch();
              }
            }}
            placeholder={t.knowledge.searchPlaceholder}
            aria-label={t.knowledge.testSearch}
            className="min-w-48 flex-1"
          />
          <Button variant="secondary" onClick={runSearch} loading={searching} disabled={searching || !searchQ.trim()}>
            {t.knowledge.testSearch}
          </Button>
        </div>
        {searching && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
        )}
        {hits && hits.length === 0 && <p className="text-sm text-ink-muted">{t.knowledge.noResults}</p>}
        {hits && hits.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-ink-muted">{t.knowledge.bestResults}</p>
            {hits.map((h) => (
              <div key={h.chunkId} className="glass-subtle rounded-xl p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="truncate text-sm font-bold text-ink">{h.documentTitle ?? h.documentId.slice(-6)}</p>
                  <Badge>{t.knowledge.relevance} <span className="num">{h.score.toFixed(3)}</span></Badge>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">{h.preview}</p>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      {/* FAQs */}
      <GlassCard id="faqs" className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-300">
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
                {f.category && <Badge className="mt-1.5">{label(f.category)}</Badge>}
              </div>
              <button onClick={() => toggleFaq(f)} className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ring-inset transition ${f.isActive ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300" : "bg-slate-500/10 text-slate-500 ring-slate-500/20"}`}>
                {f.isActive ? "نشط" : "معطل"}
              </button>
            </div>
          ))}
        </div>
      </GlassCard>

      {/* Edit modal — shared Dialog (focus trap + ESC + scroll lock) */}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={t.knowledge.edit} className="max-w-lg">
        <div className="space-y-3">
          <Field label="عنوان المستند">
            <Input value={editForm.title} onChange={(e) => setEditForm((s) => ({ ...s, title: e.target.value }))} />
          </Field>
          <Field label="التصنيف">
            <Select value={editForm.category} onChange={(e) => setEditForm((s) => ({ ...s, category: e.target.value }))}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{label(c)}</option>
              ))}
            </Select>
          </Field>
          <Field label="نص جديد (اتركه فارغًا للإبقاء على النص الحالي — التعديل يعيد الفهرسة)">
            <Textarea value={editForm.content} onChange={(e) => setEditForm((s) => ({ ...s, content: e.target.value }))} rows={5} />
          </Field>
          <div className="flex justify-start gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
            <Button size="sm" variant="primary" loading={savingEdit} disabled={savingEdit || !editForm.title.trim()} onClick={saveEdit}>{t.knowledge.save}</Button>
          </div>
        </div>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title={t.knowledge.delete}
        body={t.knowledge.deleteConfirm}
        confirmLabel={t.knowledge.delete}
        danger
      />

      {/* Detail modal */}
      <Dialog open={detail !== null} onClose={() => setDetail(null)} title={detail?.doc.title ?? ""} className="max-w-2xl">
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <Badge tone={DOC_TONE[detail?.doc.status ?? ""]} dot>{statusLabel(detail?.doc.status ?? "")}</Badge>
            <Badge>{label(detail?.doc.category ?? "") ?? detail?.doc.category}</Badge>
          </div>
          <div className="space-y-2">
            {(detail?.chunks ?? []).map((c) => (
              <div key={c.id} className="glass-subtle rounded-xl p-3">
                <p className="num mb-1 text-[10px] font-bold text-ink-subtle">#{c.chunkIndex + 1}</p>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">{c.content}</p>
              </div>
            ))}
            {(detail?.chunks ?? []).length === 0 && <p className="text-sm text-ink-muted">{t.knowledge.noResults}</p>}
          </div>
        </div>
      </Dialog>

    </div>
  );
}
