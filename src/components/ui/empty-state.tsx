import Link from "next/link";
import { ArrowLeft, Inbox } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function EmptyState({
  icon,
  illustration,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  /**
   * رسمة الحالة الفاضية (`/brand/empty-*.webp`). بتحلّ محل مربّع الأيقونة.
   * الرسمات خلفيتها **مفرّغة** — بلا هيك بتطلع مستطيل أبيض فاقع بالوضع
   * الداكن. و`alt=""` عن قصد: هي زينة، والعنوان تحتها هو النص الحقيقي،
   * فقارئ الشاشة ما بيكرّر نفس المعنى مرتين.
   */
  illustration?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-14 text-center", className)}>
      {illustration ? (
        // أصل ثابت بحجم معروف وبلا تحسين — نفس نمط باقي الصفحات بالمشروع.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={illustration}
          alt=""
          aria-hidden
          data-illustration
          width={320}
          height={240}
          loading="lazy"
          decoding="async"
          className="mb-1 h-auto w-full max-w-[260px] select-none opacity-90"
        />
      ) : (
        <div className="glass-subtle mb-2 flex h-14 w-14 items-center justify-center rounded-2xl text-ink-subtle">
          {icon ?? <Inbox size={24} strokeWidth={1.75} />}
        </div>
      )}
      <p className="text-sm font-bold text-ink">{title}</p>
      {description && <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * «الخطوة الجاية» داخل الحالة الفاضية: رابط داخلي بشكل زر — بدل حالة فاضية مسدودة
 * (الدليل بالقائمة بيحكي «شو بعد» والحالة الفاضية لازم تحكي نفس القصة).
 * نفس ألوان `Button`: أساسي أو ثانوي.
 */
export function EmptyNext({ href, children, secondary }: { href: string; children: React.ReactNode; secondary?: boolean }) {
  return (
    <Link
      href={href}
      data-empty-next
      className={cn(
        "inline-flex h-8 select-none items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary",
        secondary
          ? "border border-line bg-surface-2 text-ink hover:bg-surface-hover"
          : "bg-primary text-white hover:bg-primary-hover"
      )}
    >
      {children}
      <ArrowLeft size={13} aria-hidden />
    </Link>
  );
}

export { t as i18n };
