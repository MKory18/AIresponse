"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FlaskConical, Pencil, Plus, Power, UserRound } from "lucide-react";
import { label as enumLabel, t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
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
  version: number;
};

type PersonaVersionRow = {
  id: string;
  version: number;
  name: string;
  status: string;
  systemInstructions: string | null;
  createdAt: string;
};

/**
 * ملخص الشخصية بالعربي — كان «ar · friendly · short · helpful» خام.
 * ⚠️ «المعاينة» القديمة كانت تنادي مسار متقاعد (٤١٠) فتفشل دايمًا.
 * 🔧 كل شخصية إلها «جرّبها» بتفتح التجربة عليها مباشرة (`?persona=`).
 */
const VALUE_AR: Record<string, string> = {
  ar: "عربي", en: "إنجليزي",
  friendly: "ودودة", professional: "احترافية", playful: "مرحة",
  informal: "غير رسمية", formal: "رسمية",
  short: "رد قصير", medium: "رد متوسط", long: "رد طويل",
};
const ar = (v: string | null | undefined) => (v ? VALUE_AR[v] ?? v : "");

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [versions, setVersions] = useState<Record<string, PersonaVersionRow[]>>({});
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<{ personaId: string; version: number; name: string } | null>(null);
  const [versionBusy, setVersionBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const personasRes = await fetch("/api/personas");
      if (!personasRes.ok) throw new Error();
      setPersonas((await personasRes.json()).items);
      setError(null);
    } catch {
      setError("تعذّر تحميل الشخصيات");
    } finally {
      setLoading(false);
    }
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
      setSaveError(null);
      setShowForm(false);
      load();
    } else {
      // Surface validation/config errors — never fail a persona save silently.
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setSaveError(data.message ?? data.error ?? `فشل الحفظ (${res.status})`);
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

  async function loadVersions(personaId: string) {
    const res = await fetch(`/api/personas/${personaId}/versions`);
    if (res.ok) {
      const data = (await res.json()) as { items?: PersonaVersionRow[] };
      setVersions((prev) => ({ ...prev, [personaId]: data.items ?? [] }));
      setVersionsError(null);
    } else {
      setVersionsError("فشل تحميل الإصدارات");
    }
  }

  async function snapshot(personaId: string) {
    const res = await fetch(`/api/personas/${personaId}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (res.ok) loadVersions(personaId);
    else setVersionsError("فشل إنشاء المسودة");
  }

  async function publish(personaId: string, version: number) {
    setVersionBusy(`publish:${personaId}:${version}`);
    try {
      const res = await fetch(`/api/personas/${personaId}/versions/${version}/publish`, { method: "POST" });
      if (!res.ok) throw new Error();
      setVersionsError(null);
      load();
      loadVersions(personaId);
    } catch {
      setVersionsError("فشل النشر");
    } finally {
      setVersionBusy(null);
    }
  }

  async function rollback(personaId: string, version: number) {
    setVersionBusy(`rollback:${personaId}:${version}`);
    try {
      const res = await fetch(`/api/personas/${personaId}/versions/${version}/rollback`, { method: "POST" });
      if (!res.ok) throw new Error();
      setRollbackTarget(null);
      setVersionsError(null);
      load();
      loadVersions(personaId);
    } catch {
      setVersionsError("فشل الرجوع");
    } finally {
      setVersionBusy(null);
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

      {!loading && error && (
        <GlassCard>
          <ErrorState onRetry={load} />
        </GlassCard>
      )}

      {!loading && !error && (
        <div className="space-y-2.5">
          {personas.map((p) => (
            <div key={p.id} className="space-y-2.5">
              <GlassCard className="flex flex-wrap items-center justify-between gap-3 p-4 transition-colors hover:border-brand-300/80 dark:hover:border-brand-700">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
                  <UserRound size={18} />
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
                    {p.name}
                    {p.isActive && <Badge tone="DELIVERED" dot>الافتراضية للمساحة</Badge>}
                    <span className="num text-[11px] font-medium text-ink-muted">v{p.version ?? 1}</span>
                  </p>
                  <p className="num mt-1 text-xs text-ink-muted">
                    {ar(p.language)}{p.dialect ? ` — ${p.dialect}` : ""} · {ar(p.tone)} · {ar(p.responseLength)} · إيموجي {p.emojiLevel}/5{p.salesStyle ? ` · ${p.salesStyle}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {!p.isActive && (
                  <Button size="sm" variant="success" onClick={() => activate(p)}>
                    <Power size={13} /> تعيين كافتراضية
                  </Button>
                )}
                <Link href={`/ai/playground?persona=${p.id}`}>
                  <Button size="sm" variant="secondary">
                    <FlaskConical size={13} /> جرّبها
                  </Button>
                </Link>
                <Button size="sm" variant="secondary" onClick={() => startEdit(p)}>
                  <Pencil size={13} /> {t.common.edit}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => loadVersions(p.id)}>
                  الإصدارات
                </Button>
                <Button size="sm" variant="ghost" onClick={() => snapshot(p.id)}>
                  مسودة من الحالية
                </Button>
              </div>
            </GlassCard>
            {versions[p.id] && (
              <GlassCard className="p-4">
                <h3 className="text-xs font-bold text-ink">إصدارات {p.name} — النشر صريح والرجوع متاح (جرّبها بـ«التجربة» قبل النشر)</h3>
                {versionsError && <p className="mt-1 text-xs text-red-600">{versionsError}</p>}
                <div className="mt-2 space-y-1.5">
                  {(versions[p.id] ?? []).map((v) => (
                    <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2/60 px-3 py-2 text-xs">
                      <span className="text-ink">v{v.version} · {enumLabel(v.status)} · {v.name}</span>
                      <span className="flex gap-1.5">
                        {v.status === "DRAFT" && <Button size="sm" variant="secondary" disabled={versionBusy !== null} loading={versionBusy === `publish:${p.id}:${v.version}`} onClick={() => publish(p.id, v.version)}>نشر</Button>}
                        {(v.status === "PUBLISHED" || v.status === "ROLLED_BACK") && <Button size="sm" variant="ghost" disabled={versionBusy !== null} onClick={() => setRollbackTarget({ personaId: p.id, version: v.version, name: p.name })}>رجوع لهذا</Button>}
                      </span>
                    </div>
                  ))}
                  {(versions[p.id] ?? []).length === 0 && <p className="text-xs text-ink-muted">لا مسودات بعد — أنشئ مسودة من التعليمات الحالية.</p>}
                </div>
              </GlassCard>
            )}
            </div>
          ))}
        </div>
      )}
      {!loading && !error && personas.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<UserRound size={28} strokeWidth={1.5} />}
            title="لا توجد شخصيات بعد"
            description="أنشئ شخصية لتحديد نبرة المساعد وأسلوبه."
            action={<Button size="sm" onClick={startCreate}><Plus size={14} /> شخصية جديدة</Button>}
          />
        </GlassCard>
      )}

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
            <Input name="salesStyle" defaultValue={form.salesStyle} placeholder="مثال: بيساعد بلا ضغط، وبيقترح منتج مكمّل" />
          </Field>
          <Field label="تعليمات خاصة (حتى 20000 حرف)" className="sm:col-span-2">
            <Textarea
              name="systemInstructions"
              defaultValue={form.systemInstructions}
              rows={10}
              maxLength={20000}
            />
          </Field>
          <Field label="عبارات ممنوعة (سطر لكل عبارة)" className="sm:col-span-2">
            <Textarea name="prohibitedPhrases" defaultValue={form.prohibitedPhrases} rows={2} />
          </Field>
          <Field label="قواعد إضافية (سطر لكل قاعدة)" className="sm:col-span-2">
            <Textarea name="customRules" defaultValue={form.customRules} rows={2} />
          </Field>
          {saveError && (
            <p className="sm:col-span-2 text-xs font-semibold text-red-600 dark:text-red-400">{saveError}</p>
          )}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>{t.common.cancel}</Button>
            <Button type="submit">{t.common.save}</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={rollbackTarget !== null}
        onClose={() => setRollbackTarget(null)}
        onConfirm={() => rollbackTarget && void rollback(rollbackTarget.personaId, rollbackTarget.version)}
        title={`الرجوع إلى الإصدار v${rollbackTarget?.version ?? ""} من "${rollbackTarget?.name ?? ""}"؟`}
        body="سيتغير سلوك المساعد الحي في كل القنوات المرتبطة بهذه الشخصية فورًا. النسخة الحالية تبقى كإصدار قابل للاستعادة."
        confirmLabel="الرجوع لهذا الإصدار"
        busy={rollbackTarget ? versionBusy === `rollback:${rollbackTarget.personaId}:${rollbackTarget.version}` : false}
        danger
      />
    </div>
  );
}
