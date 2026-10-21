"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/i18n";
import type { SetupProgress } from "@/modules/setup/progress";

/**
 * بطاقة «ابدأ من هون» بالرئيسية: الخطوة الجاية مضيّئة، والي خلصت بعلامة ✓،
 * والي بعدها باهتة — فبتعرف وين إنت بنظرة. لما تخلص الخطوات الإجبارية بتنطوي
 * لشريط صغير «النظام جاهز».
 *
 * الحالة محسوبة على الخادم من بياناتك الحقيقية (`/api/setup/progress`) —
 * مش زر «خلصت» بتضغطه.
 */

/** عرض صرف (من غير جلب) — الاختبار بيعرضه بخصائص جاهزة. */
export function SetupChecklistView({
  progress,
  expanded = !progress.complete,
  onToggle,
}: {
  progress: SetupProgress;
  /** الشريط المطوي (النظام جاهز) بيتوسّع بزر. */
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const next = progress.steps.find((s) => s.key === progress.nextKey) ?? null;
  const pct = Math.round((progress.doneCount / progress.total) * 100);

  if (progress.complete && !expanded) {
    return (
      <section
        aria-label="خطوات البداية"
        data-setup="ready"
        className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-3 shadow-card"
      >
        <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white" aria-hidden>
            <Check size={14} strokeWidth={3} />
          </span>
          النظام جاهز — الخطوات الأساسية كلها خلصت
        </p>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={false}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-primary transition hover:bg-primary-soft"
          >
            عرض الخطوات
            <ChevronDown size={14} />
          </button>
        )}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="setup-title"
      data-setup={progress.complete ? "ready" : "steps"}
      className="rounded-2xl border border-line bg-surface-2 shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <div className="min-w-0">
          <h2 id="setup-title" className="text-sm font-bold text-ink">
            ابدأ من هون
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {next ? (
              <>
                خطوتك الجاية: <span className="font-semibold text-ink">{next.label}</span>
              </>
            ) : (
              "كل الخطوات خلصت"
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="تقدّم الخطوات"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.doneCount}
            className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-3"
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <span className="num text-xs font-semibold text-ink-muted">
            {formatNumber(progress.doneCount)} / {formatNumber(progress.total)}
          </span>
          {progress.complete && onToggle && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded
              className="rounded-lg px-2 py-1 text-xs font-semibold text-primary transition hover:bg-primary-soft"
            >
              طي
            </button>
          )}
        </div>
      </div>

      <ol className="grid grid-cols-1 gap-2 px-4 pb-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-5">
        {progress.steps.map((step, i) => {
          const isNext = step.key === progress.nextKey;
          return (
            <li key={step.key}>
              <Link
                href={step.href}
                aria-current={isNext ? "step" : undefined}
                data-step={step.key}
                data-state={step.done ? "done" : isNext ? "next" : "todo"}
                className={cn(
                  "flex h-full flex-col gap-2 rounded-xl border px-3 py-3 transition-colors",
                  step.done && "border-line bg-surface-2 hover:bg-surface-hover",
                  isNext && "border-primary bg-primary-soft",
                  !step.done && !isNext && "border-line bg-surface-3/60 hover:bg-surface-hover"
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    // ⚠️ بلا صنف `num` هون: `.num` = display:inline-block وبيطغى على
                    // flex فالرقم ما بيتمركز. الرقم بيلتفّ بـ<span class="num"> جوّا.
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                      step.done && "bg-emerald-600 text-white",
                      isNext && "bg-primary text-white",
                      !step.done && !isNext && "bg-surface-3 text-ink-muted"
                    )}
                  >
                    {step.done ? <Check size={13} strokeWidth={3} /> : <span className="num leading-none">{formatNumber(i + 1)}</span>}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate text-[13px] font-bold", step.done ? "text-ink-muted" : "text-ink")}>
                    {step.label}
                  </span>
                  {!step.required && !step.done && (
                    <span className="shrink-0 rounded-[4px] bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted">
                      اختياري
                    </span>
                  )}
                </span>
                {isNext && (
                  <>
                    <span className="text-xs leading-5 text-ink-muted">{step.hint}</span>
                    <span className="mt-auto inline-flex items-center gap-1 text-xs font-bold text-primary">
                      ابدأ
                      <ArrowLeft size={13} />
                    </span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** الغلاف: بيجيب الحالة من الخادم، وبيختفي بصمت عند 403 (موظف بلا صلاحية). */
export function SetupChecklist() {
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/progress");
        if (!res.ok) return; // 403/خطأ = ما بنعرض شي، ولا بنزعج المستخدم
        const data = (await res.json()) as SetupProgress;
        if (!cancelled) setProgress(data);
      } catch {
        /* شبكة — البطاقة اختيارية */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!progress) return null;
  return <SetupChecklistView progress={progress} expanded={progress.complete ? open : true} onToggle={() => setOpen((o) => !o)} />;
}
