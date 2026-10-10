"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { EmptyState } from "./empty-state";

/**
 * P11 — تأكيد العمليات الحساسة: نافذة حوار موحدة فوق Dialog (حظر تمرير + ESC +
 * فخ تركيز) بحالة تحميل، فلا عملية هامة تُنفَّذ بنقرة غير مقصودة.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  busy = false,
  danger = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body?: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} className="max-w-md">
      {danger && (
        <div className="mb-3 flex items-center gap-2 text-red-600 dark:text-red-400">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-500/10">
            <AlertTriangle size={17} aria-hidden />
          </span>
          <span className="text-xs font-semibold">تأكيد الإجراء</span>
        </div>
      )}
      {body && <p className="text-[13px] leading-relaxed text-ink-muted">{body}</p>}
      <div className="mt-5 flex justify-start gap-2">
        <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
          {t.common.cancel}
        </Button>
        <Button
          size="sm"
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          loading={busy}
          disabled={busy}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/** حالة خطأ موحدة مع إعادة محاولة — لا صفحة تبقى هيكل تحميل أبدًا عند فشل الطلب. */
export function ErrorState({
  title,
  description,
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      icon={<RotateCcw size={22} strokeWidth={1.75} />}
      title={title ?? "تعذّر تحميل البيانات"}
      description={description}
      className={cn("py-10", className)}
      action={
        onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RotateCcw size={13} /> {t.common.retry}
          </Button>
        )
      }
    />
  );
}
