"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Check, Cpu, KeyRound, Network, SlidersHorizontal } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/confirm";
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
  hasCustomApiKey?: boolean;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  temperature: number;
  maxTokens: number;
  confidenceExecute: number;
  confidenceRespond: number;
  aiEnabled: boolean;
  autoRespond: boolean;
};

/** الأسماء العربية لكل القيم — بما فيها القديمة، لحد ما تُرحَّل إعداداتها. */
const PROVIDER_AR: Record<string, string> = {
  mock: "وهمي (تجريبي)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  internal: "داخلي (قديم)",
  hermes: "الوكيل الذكي (سيرفرك)",
  custom: "الوكيل الذكي (سيرفرك)",
};
const providerLabel = (p: string) => PROVIDER_AR[p] ?? p;

/** المزوّدان المعروضان الوحيدان. أي مزوّد قديم مخزّن يظل ظاهراً للترحيل. */
const PROVIDER_OPTIONS = ["openrouter", "custom"];

const GATEWAY_PROVIDERS = new Set(["custom", "hermes", "internal"]);

const VALUE_HINT: Record<string, string> = {
  openrouter: "مفتاح OpenRouter بيتضبط على بيئة الخادم (OPENROUTER_API_KEY). اختر OpenRouter وقت ما يكون هو المزوّد المطلوب.",
  custom: "الوكيل الذكي على سيرفرك: عنوان OpenAI-compatible + مفتاحك من هنا — المفتاح ينخزن مشفّراً وما يظهر مرة ثانية.",
};

/** فحص اتصال حي — ping خفيف بلا أي بيانات زبون. */
function LiveProbe({ provider }: { provider: string }) {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [detail, setDetail] = useState<string | null>(null);
  async function run() {
    setState("loading");
    try {
      const res = await fetch("/api/ai/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json()) as { status?: string; detail?: string };
      if (!res.ok) throw new Error();
      setDetail(data.detail ?? data.status ?? null);
      setState(data.status === "working" || data.status === "local" ? "ok" : "fail");
    } catch {
      setState("fail");
      setDetail(null);
    }
  }
  const tone =
    state === "ok" ? "text-emerald-700 dark:text-emerald-300" : state === "fail" ? "text-red-700 dark:text-red-300" : "";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="secondary" onClick={run} loading={state === "loading"} disabled={state === "loading"}>
        فحص الاتصال
      </Button>
      {state === "ok" && (
        <Badge tone="DELIVERED" dot>
          متصل وشغّال
        </Badge>
      )}
      {state === "fail" && <span className="text-xs font-medium text-red-700 dark:text-red-300">فشل الاتصال</span>}
      {detail && (state === "ok" || state === "fail") && (
        <span className={`text-xs ${tone}`} dir="ltr">
          {detail}
        </span>
      )}
    </div>
  );
}

export default function AISettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState("custom");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/ai/settings");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as Settings;
      setSettings(data);
      setProvider(data.provider);
    } catch {
      setLoadError("تعذّر تحميل إعدادات الذكاء الاصطناعي");
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setSaveError(null);
    // Disabled inputs are omitted from FormData — only send present values
    // so saving never zeroes/clears untouched fields.
    const payload: Record<string, unknown> = {
      provider: form.get("provider"),
      classificationModel: form.get("classificationModel") || null,
      extractionModel: form.get("extractionModel") || null,
      responseModel: form.get("responseModel") || null,
      visionModel: form.get("visionModel") || null,
      summaryModel: form.get("summaryModel") || null,
      embeddingModel: form.get("embeddingModel") || null,
      customBaseUrl: form.get("customBaseUrl") || null,
      aiEnabled: form.get("aiEnabled") === "on",
      autoRespond: form.get("autoRespond") === "on",
    };
    for (const k of ["temperature", "maxTokens", "confidenceExecute", "confidenceRespond", "fallbackProvider", "fallbackModel"]) {
      const v = form.get(k);
      if (v !== null && v !== "") payload[k] = k === "fallbackProvider" || k === "fallbackModel" ? v : Number(v);
    }
    // مفتاح الوكيل: يُرسل فقط عند مجيء قيمة جديدة — فارغة = بلا تغيير.
    const wsKey = String(form.get("customApiKey") ?? "").trim();
    if (wsKey) payload.customApiKey = wsKey;
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSaving(false);
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        loadSettings();
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.message ?? "فشل الحفظ — تحقق من الصلاحيات وحاول مجددًا");
      }
    } catch {
      setSaving(false);
      setSaveError("فشل الحفظ — تعذر الاتصال بالخادم");
    }
  }

  if (loadError) {
    return (
      <div className="page-wrap">
        <PageHeader title={t.pages.aiSettingsTitle} description={t.pages.aiSettingsDesc} />
        <GlassCard className="p-2">
          <ErrorState onRetry={loadSettings} />
        </GlassCard>
      </div>
    );
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

  const isGateway = GATEWAY_PROVIDERS.has(provider);
  const options = PROVIDER_OPTIONS.includes(settings.provider)
    ? PROVIDER_OPTIONS
    : [...PROVIDER_OPTIONS, settings.provider];

  return (
    <form onSubmit={save} className="page-wrap max-w-3xl space-y-4">
      <PageHeader
        title={t.pages.aiSettingsTitle}
        description={t.pages.aiSettingsDesc}
        actions={
          saved && (
            <Badge tone="DELIVERED" dot>
              <Check size={11} />
              تم الحفظ
            </Badge>
          )
        }
      />

      {/* 1 · المزوّد */}
      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <Network size={15} />
          </span>
          المزوّد
        </h2>
        <div className="mt-3 space-y-3">
          <Field label="مين بيشغّل الذكاء؟" hint="مزوّدان فقط: OpenRouter، أو الوكيل الذكي على سيرفرك.">
            <Select name="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {options.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
          <p className="flex items-start gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-muted">
            <KeyRound size={14} className="mt-0.5 shrink-0" />
            {VALUE_HINT[provider] ?? "هذا المزوّد قديم — احفظ بعد اختيار واحد من المزوّدين المعروضين."}
          </p>
          {isGateway && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field
                label="عنوان الوكيل (OpenAI-compatible)"
                hint="مثال: https://gateway.example.com/v1 — أو رابط كامل ينتهي بـ /v1/chat/completions."
              >
                <Input
                  name="customBaseUrl"
                  defaultValue={settings.customBaseUrl ?? ""}
                  dir="ltr"
                  className="num"
                  placeholder="https://…/v1"
                />
              </Field>
              <Field
                label="مفتاح الوكيل (يُخزَّن مشفَّراً)"
                hint={
                  settings.hasCustomApiKey
                    ? "المفتاح متخزن ✅ — اكتب مفتاح جديد للاستبدال، وسيب فارغة للحفاظ على الموجود."
                    : "يُخزَّن مشفّراً ولا يُعرض بعد الحفظ."
                }
              >
                <Input
                  name="customApiKey"
                  type="password"
                  dir="ltr"
                  className="num"
                  placeholder={settings.hasCustomApiKey ? "•••• متخزن — فارغة = بلا تغيير" : "sk-…"}
                  autoComplete="off"
                />
              </Field>
            </div>
          )}
          <LiveProbe provider={provider} />
        </div>
      </GlassCard>

      {/* 2 · النماذج */}
      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-300">
            <Cpu size={15} />
          </span>
          النماذج
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          اكتب أسماء الموديلات كما بيعطيها مزوّدك. الفراغ = الموديل الافتراضي للمزوّد.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {[
            ["responseModel", "نموذج الرد (الأقوى)"],
            ["classificationModel", "نموذج التصنيف (رخيص)"],
            ["extractionModel", "نموذج الاستخراج (متوسط)"],
            ["summaryModel", "نموذج التلخيص (رخيص)"],
            ["visionModel", "نموذج الرؤية (صور)"],
            ["embeddingModel", "نموذج التضمينات (البحث)"],
          ].map(([key, fieldLabel]) => (
            <Field key={key} label={fieldLabel}>
              <Input
                name={key}
                defaultValue={(settings as never as Record<string, string | null>)[key] ?? ""}
                dir="ltr"
                className="num"
                placeholder="مثال: openai/gpt-4o-mini"
              />
            </Field>
          ))}
        </div>
      </GlassCard>

      {/* 3 · ضبط الرد */}
      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
            <SlidersHorizontal size={15} />
          </span>
          ضبط الرد
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Temperature">
            <Input name="temperature" type="number" step="0.1" min="0" max="2" defaultValue={settings.temperature} dir="ltr" className="num" />
          </Field>
          <Field label="حد التوكنات">
            <Input name="maxTokens" type="number" min="50" max="4000" defaultValue={settings.maxTokens} dir="ltr" className="num" />
          </Field>
          <Field label="حد التنفيذ">
            <Input name="confidenceExecute" type="number" step="0.05" min="0" max="1" defaultValue={settings.confidenceExecute} dir="ltr" className="num" />
          </Field>
          <Field label="حد الرد">
            <Input name="confidenceRespond" type="number" step="0.05" min="0" max="1" defaultValue={settings.confidenceRespond} dir="ltr" className="num" />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-5">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" name="aiEnabled" defaultChecked={settings.aiEnabled} className="h-4 w-4 accent-brand-500" /> تشغيل الذكاء
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" name="autoRespond" defaultChecked={settings.autoRespond} className="h-4 w-4 accent-brand-500" /> الرد الآلي
          </label>
        </div>
      </GlassCard>

      {/* 4 · البديل */}
      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-300">
            <Bot size={15} />
          </span>
          البديل عند الفشل (اختياري)
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="المزوّد البديل" hint="يستخدم فقط بعد فشل المزوّد الأساسي — لا يغيّر سياسات الخصوصية.">
            <Select name="fallbackProvider" defaultValue={settings.fallbackProvider ?? ""}>
              <option value="">بلا بديل</option>
              {options.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="موديل البديل">
            <Input name="fallbackModel" defaultValue={settings.fallbackModel ?? ""} dir="ltr" className="num" />
          </Field>
        </div>
      </GlassCard>

      {saveError && (
        <GlassCard level="glass-subtle" role="alert" className="border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 text-sm font-medium text-red-700 dark:text-red-300">
          {saveError}
        </GlassCard>
      )}

      <div className="sticky bottom-4 flex justify-end">
        <Button type="submit" loading={saving} disabled={saving} size="lg" className="shadow-glass">
          {saving ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
        </Button>
      </div>
    </form>
  );
}
