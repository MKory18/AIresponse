"use client";

import { useEffect, useState } from "react";
import { Bot, Check, Cpu, KeyRound, SlidersHorizontal } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Settings = {
  provider: string;
  classificationModel: string | null;
  extractionModel: string | null;
  responseModel: string | null;
  visionModel: string | null;
  summaryModel: string | null;
  embeddingModel: string | null;
  customBaseUrl: string | null;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  temperature: number;
  maxTokens: number;
  confidenceExecute: number;
  confidenceRespond: number;
  humanHandoffThreshold: number;
  aiEnabled: boolean;
  autoRespond: boolean;
};

export default function AISettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/ai/settings").then(async (res) => {
      if (res.ok) setSettings(await res.json());
    });
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    const num = (k: string) => Number(form.get(k));
    const res = await fetch("/api/ai/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: form.get("provider"),
        classificationModel: form.get("classificationModel") || null,
        extractionModel: form.get("extractionModel") || null,
        responseModel: form.get("responseModel") || null,
        visionModel: form.get("visionModel") || null,
        summaryModel: form.get("summaryModel") || null,
        embeddingModel: form.get("embeddingModel") || null,
        customBaseUrl: form.get("customBaseUrl") || null,
        fallbackProvider: form.get("fallbackProvider") || null,
        fallbackModel: form.get("fallbackModel") || null,
        temperature: num("temperature"),
        maxTokens: num("maxTokens"),
        confidenceExecute: num("confidenceExecute"),
        confidenceRespond: num("confidenceRespond"),
        humanHandoffThreshold: num("humanHandoffThreshold"),
        aiEnabled: form.get("aiEnabled") === "on",
        autoRespond: form.get("autoRespond") === "on",
      }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  if (!settings) {
    return (
      <div className="page-wrap">
        <PageHeader title={t.pages.aiSettingsTitle} description={t.pages.aiSettingsDesc} />
        <div className="space-y-3">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="page-wrap max-w-3xl">
      <PageHeader
        title={t.pages.aiSettingsTitle}
        description={t.pages.aiSettingsDesc}
        actions={saved && (
          <Badge tone="DELIVERED" dot>
            <Check size={11} />
            تم الحفظ
          </Badge>
        )}
      />

      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <Cpu size={15} />
          </span>
          المزود والنماذج
        </h2>
        <p className="mt-2.5 flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300">
          <KeyRound size={14} className="mt-0.5 shrink-0" />
          مفاتيح الـ API تُدار حصراً عبر متغيرات البيئة على الخادم ولا تُعرض أو تُعدّل من هنا.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="المزود">
            <Select name="provider" defaultValue={settings.provider}>
              {["mock", "openai", "openrouter", "internal"].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </Field>
          {[
            ["classificationModel", "نموذج التصنيف (رخيص)"],
            ["extractionModel", "نموذج الاستخراج (متوسط)"],
            ["responseModel", "نموذج الرد (الأقوى)"],
            ["visionModel", "نموذج الرؤية"],
            ["summaryModel", "نموذج التلخيص (رخيص)"],
            ["embeddingModel", "نموذج التضمينات"],
          ].map(([key, fieldLabel]) => (
            <Field key={key} label={fieldLabel}>
              <Input name={key} defaultValue={(settings as never as Record<string, string | null>)[key] ?? ""} dir="ltr" className="num" />
            </Field>
          ))}
          <Field label="عنوان النموذج الداخلي (OpenAI-compatible، اختياري)">
            <Input name="customBaseUrl" defaultValue={settings.customBaseUrl ?? ""} dir="ltr" className="num" placeholder="https://…" />
          </Field>
          <Field label="مزود البديل (عند الفشل فقط)">
            <Select name="fallbackProvider" defaultValue={settings.fallbackProvider ?? ""}>
              <option value="">بلا بديل</option>
              {["mock", "openai", "openrouter", "internal"].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </Field>
          <Field label="نموذج البديل">
            <Input name="fallbackModel" defaultValue={settings.fallbackModel ?? ""} dir="ltr" className="num" />
          </Field>
        </div>
      </GlassCard>

      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
            <SlidersHorizontal size={15} />
          </span>
          التوليد
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Field label="Temperature">
            <Input name="temperature" type="number" step="0.1" min="0" max="2" defaultValue={settings.temperature} dir="ltr" className="num" />
          </Field>
          <Field label="Max tokens">
            <Input name="maxTokens" type="number" min="50" max="4000" defaultValue={settings.maxTokens} dir="ltr" className="num" />
          </Field>
        </div>
      </GlassCard>

      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
            <Bot size={15} />
          </span>
          الثقة والتحكم
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="حد التنفيذ الآمن">
            <Input name="confidenceExecute" type="number" step="0.05" min="0" max="1" defaultValue={settings.confidenceExecute} dir="ltr" className="num" />
          </Field>
          <Field label="حد الرد المحدود">
            <Input name="confidenceRespond" type="number" step="0.05" min="0" max="1" defaultValue={settings.confidenceRespond} dir="ltr" className="num" />
          </Field>
          <Field label="تحويل للموظف تحت">
            <Input name="humanHandoffThreshold" type="number" step="0.05" min="0" max="1" defaultValue={settings.humanHandoffThreshold} dir="ltr" className="num" />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-5">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" name="aiEnabled" defaultChecked={settings.aiEnabled} className="h-4 w-4 accent-brand-500" /> تشغيل AI
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" name="autoRespond" defaultChecked={settings.autoRespond} className="h-4 w-4 accent-brand-500" /> الرد الآلي
          </label>
        </div>
      </GlassCard>

      <div className="sticky bottom-4 flex justify-end">
        <Button type="submit" loading={saving} disabled={saving} size="lg" className="shadow-glass">
          {saving ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
        </Button>
      </div>
    </form>
  );
}
