"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Link2, Power } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/confirm";
import { Field, Input, Select } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { providerLabel, publicDetail } from "@/lib/provider-labels";
import { GLM_ZAKIAI_PRESET, aiConnectionMode } from "@/lib/ai-connection";
import { AiStatusCard, TASK_AR, type TaskInfo } from "./ai-status-card";

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

type ModelKey = "classificationModel" | "extractionModel" | "responseModel" | "visionModel" | "summaryModel" | "embeddingModel";

const PROVIDER_OPTIONS = ["custom", "hermes", "openai", "openrouter", "internal", "mock"];

// الاسم نفسه ببطاقة الحالة وهون (`TASK_AR`) — كانوا اسمين لنفس المهمة («التصنيف» هون و«فهم النية» بالاستوديو).
const MODEL_FIELDS: { key: ModelKey; task: string; placeholder: string }[] = [
  { key: "classificationModel", task: "CLASSIFICATION", placeholder: "auto/cheap" },
  { key: "extractionModel", task: "EXTRACTION", placeholder: "auto/fast" },
  { key: "responseModel", task: "RESPONSE", placeholder: "auto/best-chat" },
  { key: "visionModel", task: "VISION", placeholder: "auto/best-vision" },
  { key: "summaryModel", task: "SUMMARY", placeholder: "auto/cheap" },
  { key: "embeddingModel", task: "EMBEDDING", placeholder: "اتركه فارغاً — محلي" },
];

const blank = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** فحص اتصال حي للمزوّد المحفوظ — ping خفيف بلا أي بيانات زبون. */
function LiveProbe({ provider }: { provider: string }) {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  async function run() {
    setState("loading");
    setMessage(null);
    setLatency(null);
    try {
      const res = await fetch("/api/ai/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json()) as { status?: string; detail?: string; latencyMs?: number };
      if (!res.ok) throw new Error();
      if (data.status === "working" || data.status === "local") {
        setState("ok");
        setLatency(data.latencyMs ?? null);
        return;
      }
      setState("fail");
      setMessage(
        data.status === "needs_key"
          ? "ناقص مفتاح"
          : data.status === "unconfigured"
            ? "ناقص عنوان أو مفتاح"
            : data.detail
              ? publicDetail(data.detail)
              : "راجع العنوان والمفتاح"
      );
    } catch {
      setState("fail");
      setMessage("تعذّر الوصول للخادم");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={run} loading={state === "loading"} disabled={state === "loading"}>
        فحص الاتصال
      </Button>
      {state === "ok" && (
        <Badge tone="DELIVERED" dot>
          متصل{latency !== null ? ` · ${latency}ms` : ""}
        </Badge>
      )}
      {state === "fail" && (
        <Badge tone="FAILED" dot>
          {message ?? "فشل الاتصال"}
        </Badge>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <GlassCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            {icon}
          </span>
          <div>
            <h2 className="text-sm font-bold text-ink">{title}</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-subtle">{description}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </GlassCard>
  );
}

/** مفتاح تشغيل بجملة بتشرح شو بيعمل — بدل مربّع صغير جنب كلمة وحدة. */
function Toggle({
  checked,
  disabled,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
        checked ? "border-primary/40 bg-primary-soft" : "border-line bg-surface-3/40 hover:bg-surface-hover",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-brand-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-bold text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{hint}</span>
      </span>
    </label>
  );
}

export default function AISettingsPage() {
  const [form, setForm] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // نتيجة التوافق لكل مهمة (من بطاقة الحالة) — بتعلّم النموذج الي ما بيناسب جنب حقله.
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [statusKey, setStatusKey] = useState(0);

  const loadSettings = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/ai/settings");
      if (!res.ok) throw new Error();
      setForm((await res.json()) as Settings);
    } catch {
      setLoadError("تعذّر تحميل إعدادات الذكاء الاصطناعي");
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function updateModel(key: ModelKey, value: string) {
    setForm((prev) => (prev ? { ...prev, [key]: value || null } : prev));
  }

  function applyGlmPreset() {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            provider: "custom",
            customBaseUrl: GLM_ZAKIAI_PRESET.baseUrl,
            ...GLM_ZAKIAI_PRESET.models,
          }
        : prev
    );
    setSaved(false);
    setSaveError(null);
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form) return;
    setSaveError(null);

    if (form.provider === "custom" && !blank(form.customBaseUrl)) {
      setSaveError("عنوان الـAPI مطلوب للمزوّد المخصص");
      return;
    }
    if (form.provider === "custom" && !form.hasCustomApiKey && !apiKey.trim()) {
      setSaveError("مفتاح الـAPI مطلوب للمزوّد المخصص");
      return;
    }
    if (form.maxTokens < 50) {
      setSaveError("أقصى عدد توكنز لازم 50 أو أكثر");
      return;
    }

    const payload: Record<string, unknown> = {
      provider: form.provider,
      classificationModel: blank(form.classificationModel),
      extractionModel: blank(form.extractionModel),
      responseModel: blank(form.responseModel),
      visionModel: blank(form.visionModel),
      summaryModel: blank(form.summaryModel),
      embeddingModel: blank(form.embeddingModel),
      fallbackProvider: form.fallbackProvider || null,
      fallbackModel: blank(form.fallbackModel),
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      confidenceExecute: form.confidenceExecute,
      confidenceRespond: form.confidenceRespond,
      aiEnabled: form.aiEnabled,
      autoRespond: form.autoRespond,
    };

    // حقل العنوان ما بينرسل للمزوّدين اللي مفاتيحهم من بيئة الخادم —
    // حتى ما نمسح عنواناً محفوظاً لمجرد تبديل المزوّد.
    if (aiConnectionMode(form.provider) !== "environment") {
      payload.customBaseUrl = blank(form.customBaseUrl);
    }
    if (apiKey.trim()) payload.customApiKey = apiKey.trim();

    setSaving(true);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSaving(false);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.message ?? "فشل الحفظ — تحقق من الصلاحيات وحاول مجددًا");
        return;
      }
      setSaved(true);
      setApiKey("");
      setTimeout(() => setSaved(false), 2000);
      loadSettings();
      setStatusKey((k) => k + 1);
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

  if (!form) {
    return (
      <div className="page-wrap">
        <PageHeader title={t.pages.aiSettingsTitle} description={t.pages.aiSettingsDesc} />
        <div className="space-y-3">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </div>
    );
  }

  const mode = aiConnectionMode(form.provider);

  return (
    <form onSubmit={save} className="page-wrap max-w-4xl space-y-4 pb-8">
      <PageHeader title={t.pages.aiSettingsTitle} description={t.pages.aiSettingsDesc} />

      <AiStatusCard key={statusKey} onTasks={setTasks} />

      <Section
        icon={<Power size={15} />}
        title="التشغيل"
        description="قرارين بس: الذكاء شغّال؟ وبيرد على العميل لحاله ولا بيستنّى موظف؟"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle
            checked={form.aiEnabled}
            onChange={(v) => update("aiEnabled", v)}
            title="تشغيل الذكاء"
            hint="بيقرأ الرسائل، بيقترح ردود، وبيجمع بيانات الطلب."
          />
          <Toggle
            checked={form.autoRespond}
            disabled={!form.aiEnabled}
            onChange={(v) => update("autoRespond", v)}
            title="الرد الآلي"
            hint="الوكيل بيبعت رده للعميل لحاله بلا ما يستنّى موظف. جرّبه بـ«التجربة» قبل."
          />
        </div>
      </Section>

      <Section
        icon={<Link2 size={15} />}
        title="الاتصال"
        description="المزوّد وعنوانه ومفتاحه — المفتاح ينخزن مشفّراً وما بينعرض بعدها."
        action={
          <Button type="button" variant="secondary" size="sm" onClick={applyGlmPreset}>
            تعبئة GLM
          </Button>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="المزوّد" hint="GLM جاهز: اضغط «تعبئة GLM» وبعدها احفظ.">
            <Select value={form.provider} onChange={(e) => update("provider", e.target.value)}>
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </Select>
          </Field>

          {mode === "custom" && (
            <>
              <Field label="عنوان الـAPI" hint="متوافق مع OpenAI — بينتهي بـ /v1.">
                <Input
                  value={form.customBaseUrl ?? ""}
                  onChange={(e) => update("customBaseUrl", e.target.value)}
                  placeholder="https://example.com/v1"
                  dir="ltr"
                  className="num"
                />
              </Field>
              <Field
                label="المفتاح"
                className="md:col-span-2"
                hint={
                  form.hasCustomApiKey
                    ? "المفتاح متخزن ✅ — اكتب مفتاح جديد للاستبدال، أو سيب فارغ."
                    : "ينخزن مشفّراً وما بينعرض بعد الحفظ."
                }
              >
                <PasswordInput
                  kind="secret"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={form.hasCustomApiKey ? "•••• متخزن — فارغة = بلا تغيير" : "sk-…"}
                  dir="ltr"
                  className="num"
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          {mode === "endpoint" && (
            <Field label="عنوان الاتصال (اختياري)" hint="إذا فاضي، بينقرأ من بيئة الخادم.">
              <Input
                value={form.customBaseUrl ?? ""}
                onChange={(e) => update("customBaseUrl", e.target.value)}
                placeholder="https://…"
                dir="ltr"
                className="num"
              />
            </Field>
          )}

          {mode === "environment" && (
            <div className="flex items-center rounded-xl bg-surface-3/50 px-3 py-2 text-xs text-ink-muted md:col-span-2">
              مفتاح هذا المزوّد بينضبط من بيئة الخادم — ما بينكتب هنا.
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <LiveProbe key={form.provider} provider={form.provider} />
          <span className="text-[11px] text-ink-subtle">الفحص بيستخدم الإعدادات المحفوظة.</span>
        </div>
      </Section>

      <details className="rounded-2xl border border-line bg-surface-2 px-4 py-3">
        <summary className="cursor-pointer select-none text-sm font-semibold text-ink">
          متقدّم — النماذج وأسلوب التوليد والبديل
        </summary>
        <p className="mt-1 text-[11px] text-ink-subtle">الافتراضي بيكفي لأغلب المتاجر — غيّر هون بس إذا بتعرف شو بتعمل.</p>

        <p className="mt-4 text-xs font-bold text-ink">نموذج كل مهمة</p>
        <p className="mt-0.5 text-[11px] text-ink-subtle">الفارغ = الافتراضي. فهرسة المعرفة محلية — اتركها فارغة إلا إذا عندك نموذج خاص.</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODEL_FIELDS.map((field) => {
            const info = tasks.find((x) => x.task === field.task);
            return (
              <Field
                key={field.key}
                label={TASK_AR[field.task] ?? field.task}
                hint={info && !info.compatible ? "⚠️ هالنموذج ما بيناسب المهمة" : undefined}
              >
                <Input
                  value={form[field.key] ?? ""}
                  onChange={(e) => updateModel(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  dir="ltr"
                  className="num"
                />
              </Field>
            );
          })}
        </div>

        <p className="mt-4 text-xs font-bold text-ink">أسلوب التوليد</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Field label="درجة الإبداع" hint="0 = نفس الرد كل مرة · 1 = متنوّع. المقترح 0.3–0.7">
            <Input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={form.temperature}
              onChange={(e) => update("temperature", Number(e.target.value))}
              dir="ltr"
              className="num"
            />
          </Field>
          <Field label="أقصى طول للرد" hint="بالتوكنز — كل ١٠٠ ≈ ٧٠ كلمة">
            <Input
              type="number"
              min="50"
              max="4000"
              value={form.maxTokens}
              onChange={(e) => update("maxTokens", Number(e.target.value))}
              dir="ltr"
              className="num"
            />
          </Field>
        </div>
        {/* «حد التنفيذ» و«حد الرد» (confidenceExecute/Respond) انشالوا من الشاشة:
            بينحفظوا بس ولا كود وقت التشغيل بيقرأهم — حقل بلا أثر بيضلّل. القيمة
            المحفوظة بتضل زي ما هي (بتنبعت مع الحفظ بلا تغيير). */}

        <p className="mt-4 text-xs font-bold text-ink">بديل عند الفشل</p>
        <p className="mt-0.5 text-[11px] text-ink-subtle">بيستخدم فقط إذا فشل المزوّد الأساسي.</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Field label="مزوّد البديل">
            <Select
              value={form.fallbackProvider ?? ""}
              onChange={(e) => update("fallbackProvider", e.target.value || null)}
            >
              <option value="">بلا بديل</option>
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="نموذج البديل">
            <Input
              value={form.fallbackModel ?? ""}
              onChange={(e) => update("fallbackModel", e.target.value)}
              placeholder="auto/best-chat"
              dir="ltr"
              className="num"
            />
          </Field>
        </div>
      </details>

      {saveError && (
        <GlassCard
          level="glass-subtle"
          role="alert"
          className="border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 text-sm font-medium text-red-700 dark:text-red-300"
        >
          {saveError}
        </GlassCard>
      )}

      <div className="flex items-center justify-end gap-3 rounded-2xl border border-line bg-surface-2 px-3 py-2 shadow-card">
        {saved && (
          <Badge tone="DELIVERED" dot>
            <Check size={11} />
            تم الحفظ
          </Badge>
        )}
        <Button type="submit" loading={saving} disabled={saving} size="lg">
          {saving ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
        </Button>
      </div>
    </form>
  );
}
