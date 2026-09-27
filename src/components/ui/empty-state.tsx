import { Inbox } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-14 text-center", className)}>
      <div className="glass-subtle mb-2 flex h-14 w-14 items-center justify-center rounded-2xl text-ink-subtle">
        {icon ?? <Inbox size={24} strokeWidth={1.75} />}
      </div>
      <p className="text-sm font-bold text-ink">{title}</p>
      {description && <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export { t as i18n };
