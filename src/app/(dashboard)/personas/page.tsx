"use client";

import { useCallback, useEffect, useState } from "react";

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

const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

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

  const load = useCallback(async () => {
    const res = await fetch("/api/personas");
    if (res.ok) setPersonas((await res.json()).items);
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">شخصية AI</h1>
        <button onClick={startCreate} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
          + شخصية جديدة
        </button>
      </div>

      {showForm && (
        <form onSubmit={save} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-3">
          <input name="name" required defaultValue={form.name} placeholder="الاسم (مثال: سارة)" className={input} />
          <input name="language" defaultValue={form.language} placeholder="اللغة" className={input} />
          <input name="dialect" defaultValue={form.dialect} placeholder="اللهجة (مثال: syrian)" className={input} />
          <input name="tone" defaultValue={form.tone} placeholder="النبرة (friendly…)" className={input} />
          <input name="formality" defaultValue={form.formality} placeholder="الرسمية" className={input} />
          <input name="responseLength" defaultValue={form.responseLength} placeholder="طول الرد" className={input} />
          <input name="emojiLevel" type="number" min="0" max="5" defaultValue={form.emojiLevel} placeholder="مستوى الإيموجي 0-5" className={input} />
          <input name="salesStyle" defaultValue={form.salesStyle} placeholder="أسلوب البيع" className={input} />
          <input name="systemInstructions" defaultValue={form.systemInstructions} placeholder="تعليمات خاصة" className={input} />
          <textarea name="prohibitedPhrases" defaultValue={form.prohibitedPhrases} placeholder="عبارات ممنوعة (سطر لكل عبارة)" rows={2} className={`${input} md:col-span-3`} />
          <textarea name="customRules" defaultValue={form.customRules} placeholder="قواعد إضافية (سطر لكل قاعدة)" rows={2} className={`${input} md:col-span-2`} />
          <div className="flex gap-2">
            <button type="submit" className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">حفظ</button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">إلغاء</button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {personas.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <div>
              <p className="text-sm font-semibold">
                {p.name}
                {p.isActive && <span className="ms-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">نشطة</span>}
              </p>
              <p className="text-xs text-slate-500">
                {p.language}{p.dialect ? ` — ${p.dialect}` : ""} · {p.tone} · {p.responseLength} · إيموجي {p.emojiLevel}/5 · {p.salesStyle}
              </p>
            </div>
            <div className="flex gap-1.5">
              {!p.isActive && (
                <button onClick={() => activate(p)} className="rounded-lg border border-emerald-300 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50">تفعيل</button>
              )}
              <button onClick={() => startEdit(p)} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">تعديل</button>
            </div>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-bold text-slate-700">معاينة الرد (Dry-run — لا يُرسل أي شيء للفيسبوك)</h2>
        <button onClick={runPreview} disabled={previewing} className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50">
          {previewing ? "جارٍ التوليد…" : "تشغيل المعاينة على سؤال «بكم المنتج؟»"}
        </button>
        {preview && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-violet-50 p-3 text-sm text-violet-800">{preview}</p>}
      </section>
    </div>
  );
}
