"use client";

import Link from "next/link";
import { ArrowLeft, CircleHelp, Lightbulb, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PageGuide } from "@/lib/page-guides";

/**
 * لوحة «شو هاي الصفحة؟» — سطرين وخطوة جاية.
 *
 * - صفحة عادية: شريط بالتدفّق تحت الشريط العلوي (بيدفع المحتوى).
 * - `overlay` (صندوق الوارد، شاشة كاملة بارتفاع محسوب): طبقة فوق المحتوى حتى
 *   ما تخرّب ارتفاع الأعمدة الثلاثة.
 *
 * `nextAllowed`: الشل بيحسبه من صلاحيات العضو — «الخطوة الجاية» الي بتودّي
 * لصفحة ممنوعة عليه ما بتظهر (بدل ما يوصل لـ ٤٠٣).
 */
export function PageGuidePanel({
  guide,
  nextAllowed,
  overlay = false,
  onClose,
}: {
  guide: PageGuide;
  nextAllowed: boolean;
  overlay?: boolean;
  onClose: () => void;
}) {
  return (
    <div
      id="page-guide"
      role="region"
      aria-label="شرح الصفحة"
      data-guide={overlay ? "overlay" : "inline"}
      className={cn(
        overlay
          ? "absolute inset-x-3 top-full z-30 mt-2 sm:inset-x-6"
          : "px-4 pt-4 lg:px-6 lg:pt-6"
      )}
    >
      <div
        className={cn(
          "mx-auto flex max-w-7xl items-start gap-3 rounded-2xl border border-primary/25 bg-primary-soft p-3.5",
          overlay && "max-w-2xl shadow-pop"
        )}
      >
        <span
          aria-hidden
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white"
        >
          <CircleHelp size={17} />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-[13px] font-bold text-ink">شو هاي الصفحة؟</p>
          <p className="text-[13px] leading-6 text-ink-muted">{guide.what}</p>
          {guide.tip && (
            <p className="flex items-start gap-1.5 text-xs leading-5 text-ink-muted">
              <Lightbulb size={13} className="mt-0.5 shrink-0 text-primary" aria-hidden />
              {guide.tip}
            </p>
          )}
          {nextAllowed && (
            <p className="pt-0.5 text-[13px]">
              <span className="text-ink-muted">الخطوة الجاية: </span>
              <Link
                href={guide.next.href}
                className="inline-flex items-center gap-1 font-bold text-primary hover:underline"
              >
                {guide.next.label}
                <ArrowLeft size={13} aria-hidden />
              </Link>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق الشرح"
          className="shrink-0 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
