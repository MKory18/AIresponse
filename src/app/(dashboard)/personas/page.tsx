"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Play, Plus, Power, UserRound } from "lucide-react";
import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Persona = {
  id: string;
  name: string;
  language: string;
  dialect: string | null;
  tone: string;
  formality: string;
  responseLength: string;
  emojiLevel: number;
  salesStyle: string;
  systemInstructions: string | null;
  prohibitedPhrases: string[];
  customRules: string[];
  isActive: boolean;
};

const EMPTY = {
  name: "", language: "ar", dialect: "", tone: "friendly", formality: "informal",
  responseLength: "short", emojiLevel: 1, salesStyle: "helpful",
  systemInstructions: "", prohibitedPhrases: "", customRules: "",
};

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/personas");
    if (res.ok) setPersonas((await res.json()).items);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function startCreate() {
    setForm(EMPTY);
    setEditing(null);
    setShowForm(true);
  }

  function startEdit(p: Persona) {
    setForm({
      name: p.name, language: p.language, dialect: p.dialect ?? "", tone: p.tone,
      formality: p.formality, responseLength: p.responseLength, emojiLevel: p.emojiLevel,
      salesStyle: p.salesStyle, systemInstructions: p.systemInstructions ?? "",
      prohibitedPhrases: p.prohibitedPhrases.join("\n"), customRules: p.customRules.join("\n"),
    });
    setEditing(p.id);
    setShowForm(true);
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = {
      name: fd.get("name"),
      language: fd.get("language"),
      dialect: fd.get("dialect") || null,
      tone: fd.get("tone"),
      formality: fd.get("formality"),
      responseLength: fd.get("responseLength"),
      emojiLevel: Number(fd.get("emojiLevel")),
      salesStyle: fd.get("salesStyle"),
      systemInstructions: fd.get("systemInstructions") || null,
      prohibitedPhrases: String(fd.get("prohibitedPhrases") || "").split("\n").map((s) => s.trim()).filter(Boolean),
      customRules: String(fd.get("customRules") || "").split("\n").map((s) => s.trim()).filter(Boolean),
    };
    const res = await fetch("/api/personas", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? { id: editing, ...payload } : payload),
    });
    if (res.ok) {
      setShowForm(false);
      load();
    }
  }

  async function activate(p: Persona) {
    await fetch("/api/personas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id, isActive: true }),
    });
    load();
  }

  async function runPreview() {
    // Preview: runs the orchestrator in dry-run against the active persona and
    // the demo conversation — nothing is ever sent to Facebook.
    setPreviewing(true);
    setPreview(null);
    const convs = await fetch("/api/conversations?limit=1").then(async (r) => (r.ok ? r.json() : null));
    const conversationId = convs?.items?.[0]?.id;
    if (!conversationId) {
      setPreview("لا توجد محادثة للمعاينة — أنشئ محادثة من الـ seed أولًا.");
      setPreviewing(false);
      return;
    }
    const res = await fetch("/api/ai/playground", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, simulateText: "بكم المنتج؟" }),
    });
    setPreviewing(false);
    if (res.ok) {
      const data = await res.json();
      setPreview(data.response ?? data.status);
    } else {
      setPreview("فشلت المعاينة");
    }
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title={t.pages.personasTitle}
        description={t.pages.personasDesc}
        actions={
          <Button size="sm" onClick={startCreate}>
            <Plus size={14} /> شخصية جديدة
          </Button>
        }
      />

      {loading && (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
        </div>
      )}

      {!loading && (
        <div className="space-y-2.5">
          {personas.map((p) => (
            <GlassCard key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4 transition-all hover:shadow-glass">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-brand-500/20 text-brand-600 dark:text-brand-300">
                  <UserRound size={18} />
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
                    {p.name}
                    {p.isActive && <Badge tone="DELIVERED" dot>نشطة</Badge>}
                  </p>
                  <p className="num mt-1 text-xs text-ink-muted">
                    {p.language}{p.dialect ? ` — ${p.dialect}` : ""} · {p.tone} · {p.responseLength} · إيموجي {p.emojiLevel}/5 · {p.salesStyle}
                  </p>
                </div>
              </div>
              <div className="flex gap-1.5">
                {!p.isActive && (
                  <Button size="sm" variant="success" onClick={() => activate(p)}>
                    <Power size={13} /> تفعيل
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => startEdit(p)}>
                  <Pencil size={13} /> {t.common.edit}
                </Button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
      {!loading && personas.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<UserRound size={28} strokeWidth={1.5} />}
            title="لا توجد شخصيات بعد"
            description="أنشئ شخصية لتحديد نبرة المساعد وأسلوبه."
            action={<Button size="sm" onClick={startCreate}><Plus size={14} /> شخصية جديدة</Button>}
          />
        </GlassCard>
      )}

      <GlassCard className="border-violet-500/20 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
            <Play size={14} />
          </span>
          معاينة الرد (تجربة آمنة — لا يُرسل أي شيء للفيسبوك)
        </h2>
        <Button size="sm" variant="secondary" onClick={runPreview} loading={previewing} disabled={previewing} className="mt-3">
          {!previewing && <Play size={13} />}
          {previewing ? "جارٍ التوليد…" : "تشغيل المعاينة على سؤال «بكم المنتج؟»"}
        </Button>
        {preview && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-violet-500/10 p-3.5 text-sm leading-relaxed text-violet-900 ring-1 ring-inset ring-violet-500/20 dark:text-violet-200">{preview}</p>}
      </GlassCard>

      <Dialog open={showForm} onClose={() => setShowForm(false)} title={editing ? t.common.edit : "شخصية جديدة"}>
        <form onSubmit={save} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="الاسم">
            <Input name="name" required defaultValue={form.name} placeholder="مثال: سارة" />
          </Field>
          <Field label="اللغة">
            <Select name="language" defaultValue={form.language}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label="اللهجة">
            <Input name="dialect" defaultValue={form.dialect} placeholder="مثال: شامية" />
          </Field>
          <Field label="النبرة">
            <Select name="tone" defaultValue={form.tone}>
              <option value="friendly">ودودة</option>
              <option value="professional">احترافية</option>
              <option value="playful">مرحة</option>
            </Select>
          </Field>
          <Field label="الرسمية">
            <Select name="formality" defaultValue={form.formality}>
              <option value="informal">غير رسمية</option>
              <option value="formal">رسمية</option>
            </Select>
          </Field>
          <Field label="طول الرد">
            <Select name="responseLength" defaultValue={form.responseLength}>
              <option value="short">قصير</option>
              <option value="medium">متوسط</option>
              <option value="long">طويل</option>
            </Select>
          </Field>
          <Field label="مستوى الرموز (0-5)">
            <Input name="emojiLevel" type="number" min="0" max="5" defaultValue={form.emojiLevel} dir="ltr" className="num" />
          </Field>
          <Field label="أسلوب البيع">
            <Input name="salesStyle" defaultValue={form.salesStyle} placeholder="مثال: helpful" />
          </Field>
          <Field label="تعليمات خاصة" className="sm:col-span-2">
            <Textarea name="systemInstructions" defaultValue={form.systemInstructions} rows={2} />
          </Field>
          <Field label="عبارات ممنوعة (سطر لكل عبارة)" className="sm:col-span-2">
            <Textarea name="prohibitedPhrases" defaultValue={form.prohibitedPhrases} rows={2} />
          </Field>
          <Field label="قواعد إضافية (سطر لكل قاعدة)" className="sm:col-span-2">
            <Textarea name="customRules" defaultValue={form.customRules} rows={2} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>{t.common.cancel}</Button>
            <Button type="submit">{t.common.save}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
