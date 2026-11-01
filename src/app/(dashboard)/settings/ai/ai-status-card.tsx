"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FlaskConical, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard } from "@/components/ui/card";
import { providerLabel, publicDetail } from "@/lib/provider-labels";

/**
 * حالة الوكيل بسطر واحد — كانت صفحة «الاستوديو» لحالها.
 *
 * ⚠️ قبل: «الاستوديو» كان نسخة للقراءة من هالصفحة (نفس المزوّد · نفس النماذج ·
 * نفس فحص الاتصال) ومعه رسالة خام «aiEnabled = false». فالمستخدم بيتنقّل بين
 * صفحتين ليعرف إذا الوكيل شغّال.
 * 🔧 هلأ: بطاقة فوق الإعدادات بتجاوب «الوكيل بيرد لحاله ولا لأ؟» وشو الناقص،
 * وتنبيه للنموذج الي ما بيناسب مهمته. الأرقام من `GET /api/ai/status` (بلا مفاتيح).
 */

export type TaskInfo = {
  task: string;
  model: string;
  compatible: boolean;
  compatibilityReason: string;
};

type StatusData = {
  aiEnabled: boolean;
  autoRespond: boolean;
  effectiveProvider: { name: string; delivery: string; status: string } | null;
  tasks: TaskInfo[];
  knowledge: { ready: number; processing: number; failed: number; faqs: number; personas: number };
};

const PROVIDER_STATUS_AR: Record<string, string> = {
  working: "يعمل",
  configured: "مهيأ",
  local: "يعمل محليًا",
  needs_key: "يحتاج مفتاح",
  needs_env: "يحتاج ضبط على الخادم",
  failed: "فشل الاتصال",
  unconfigured: "غير مهيأ",
  disabled: "متوقف",
};

const READY_STATUSES = new Set(["working", "configured"]);

export const TASK_AR: Record<string, string> = {
  CLASSIFICATION: "فهم النية",
  EXTRACTION: "استخراج البيانات",
  RESPONSE: "كتابة الرد",
  VISION: "قراءة الصور",
  SUMMARY: "تلخيص المحادثة",
  EMBEDDING: "فهرسة المعرفة",
  RETRIEVAL: "البحث بالمعرفة",
};

/** شو حالة الوكيل بكلمة — ومن هون بيطلع لون الشارة والجملة. */
function headline(d: StatusData): { tone: string; title: string; hint: string } {
  const providerOk = READY_STATUSES.has(d.effectiveProvider?.status ?? "");
  if (!d.aiEnabled) {
    return { tone: "CLOSED", title: "الذكاء متوقف", hint: "ما في ولا اقتراح ولا رد. فعّل «تشغيل الذكاء» تحت." };
  }
  if (!providerOk) {
    return { tone: "FAILED", title: "ناقص مزوّد ذكاء", hint: "اختر مزوّد واكتب مفتاحه بقسم «الاتصال»، وبعدها «فحص الاتصال»." };
  }
  if (!d.autoRespond) {
    return { tone: "PENDING", title: "الذكاء شغّال — الرد الآلي مطفي", hint: "الوكيل بيقترح والموظف بيبعت. جرّبه، وبعدها فعّل «الرد الآلي»." };
  }
  return { tone: "DELIVERED", title: "الوكيل بيرد على العملاء لحاله", hint: "راقب أول المحادثات من «الوارد»." };
}

export function AiStatusCard({ onTasks }: { onTasks?: (tasks: TaskInfo[]) => void }) {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/ai/status");
      if (!res.ok) throw new Error();
      const d = (await res.json()) as StatusData;
      setData(d);
      onTasks?.(d.tasks);
    } catch {
      setError(true);
    }
  }, [onTasks]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <GlassCard className="flex flex-wrap items-center justify-between gap-2 p-4">
        <p className="text-sm text-ink-muted">تعذّر قراءة حالة الوكيل.</p>
        <Button type="button" size="sm" variant="ghost" onClick={load}>
          <RefreshCw size={14} /> إعادة المحاولة
        </Button>
      </GlassCard>
    );
  }
  if (!data) return <Skeleton className="h-28 rounded-2xl" />;

  const h = headline(data);
  const k = data.knowledge;
  const badModels = data.tasks.filter((t) => !t.compatible);
  const provider = data.effectiveProvider;

  return (
    <GlassCard className="space-y-3 p-4 sm:p-5" data-ai-status>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Badge tone={h.tone} dot>
            {h.title}
          </Badge>
          <p className="text-[13px] leading-6 text-ink-muted">{h.hint}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={load} aria-label="تحديث الحالة">
            <RefreshCw size={14} />
          </Button>
          <Link href="/ai/playground">
            <Button type="button" size="sm" variant="secondary">
              <FlaskConical size={14} /> جرّب الوكيل
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-xl bg-surface-3/50 px-3 py-2">
          <span className="block text-ink-subtle">المزوّد</span>
          <span className="mt-0.5 block font-bold text-ink">
            {providerLabel(provider?.name)}
            <span className="ms-1 font-normal text-ink-muted">
              · {PROVIDER_STATUS_AR[provider?.status ?? ""] ?? "غير معروف"}
            </span>
          </span>
        </div>
        <Link href="/personas" className="rounded-xl bg-surface-3/50 px-3 py-2 transition-colors hover:bg-surface-hover">
          <span className="block text-ink-subtle">الشخصيات</span>
          <span className="mt-0.5 block font-bold text-ink">{k.personas}</span>
        </Link>
        <Link href="/knowledge" className="rounded-xl bg-surface-3/50 px-3 py-2 transition-colors hover:bg-surface-hover">
          <span className="block text-ink-subtle">مستندات المعرفة</span>
          <span className="mt-0.5 block font-bold text-ink">
            {k.ready}
            {k.processing > 0 && <span className="ms-1 font-normal text-ink-muted">· {k.processing} قيد التجهيز</span>}
            {k.failed > 0 && <span className="ms-1 font-normal text-red-600 dark:text-red-400">· {k.failed} فشلت</span>}
          </span>
        </Link>
        <Link href="/knowledge" className="rounded-xl bg-surface-3/50 px-3 py-2 transition-colors hover:bg-surface-hover">
          <span className="block text-ink-subtle">أسئلة شائعة</span>
          <span className="mt-0.5 block font-bold text-ink">{k.faqs}</span>
        </Link>
      </div>

      {badModels.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 ring-1 ring-inset ring-red-500/20 dark:text-red-300">
          {badModels.map((t) => (
            <li key={t.task}>
              نموذج «{TASK_AR[t.task] ?? t.task}» ما بيناسب مهمته: {publicDetail(t.compatibilityReason)} — عدّله من «متقدّم» تحت.
            </li>
          ))}
        </ul>
      )}

      {(k.personas === 0 || k.ready + k.faqs === 0) && (
        <p className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
          قبل التشغيل:
          {k.personas === 0 && (
            <Link href="/personas" className="inline-flex items-center gap-0.5 font-bold text-primary hover:underline">
              اضبط شخصية <ArrowLeft size={12} aria-hidden />
            </Link>
          )}
          {k.ready + k.faqs === 0 && (
            <Link href="/knowledge" className="inline-flex items-center gap-0.5 font-bold text-primary hover:underline">
              أضف أسئلة شائعة <ArrowLeft size={12} aria-hidden />
            </Link>
          )}
        </p>
      )}
    </GlassCard>
  );
}
