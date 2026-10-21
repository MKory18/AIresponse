import { Inbox } from "lucide-react";
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

export { t as i18n };
