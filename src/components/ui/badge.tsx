import { cn } from "@/lib/cn";
import { label } from "@/lib/i18n";

const TONES: Record<string, string> = {
  OPEN: "bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300",
  PENDING: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  RESOLVED: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  CLOSED: "bg-slate-500/10 text-slate-500 ring-slate-500/20 dark:text-slate-400",
  NEW: "bg-brand-500/10 text-brand-700 ring-brand-500/25 dark:text-brand-300",
  CONFIRMED: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  CONFIRMATION_PENDING: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  PROCESSING: "bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300",
  OUT_FOR_DELIVERY: "bg-indigo-500/10 text-indigo-700 ring-indigo-500/25 dark:text-indigo-300",
  DELIVERED: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  CANCELLED: "bg-slate-500/10 text-slate-500 ring-slate-500/20 dark:text-slate-400",
  FAILED: "bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300",
  RETURNED: "bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:text-orange-300",
  CONFIRMED_BY_CUSTOMER: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  CONFIRMED_BY_AGENT: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  DECLINED: "bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300",
  URGENT: "bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300",
  HIGH: "bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:text-orange-300",
  NORMAL: "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300",
  LOW: "bg-slate-500/10 text-slate-500 ring-slate-500/20 dark:text-slate-400",
  CONNECTED: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  DISCONNECTED: "bg-slate-500/10 text-slate-500 ring-slate-500/20 dark:text-slate-400",
  CONNECTING: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  ERROR: "bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300",
  IN_STOCK: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  OUT_OF_STOCK: "bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300",
  PRE_ORDER: "bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300",
  DISCONTINUED: "bg-slate-500/10 text-slate-500 ring-slate-500/20 dark:text-slate-400",
  DONE: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  RUNNING: "bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300",
  SCHEDULED: "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300",
  SENT: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  SKIPPED: "bg-slate-500/10 text-slate-500 ring-slate-500/20 dark:text-slate-400",
  PAID: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  UNPAID: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  COD: "bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300",
  AI_ACTIVE: "bg-brand-500/10 text-brand-700 ring-brand-500/25 dark:text-brand-300",
  AI_PAUSED: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  HUMAN_ACTIVE: "bg-violet-500/10 text-violet-700 ring-violet-500/25 dark:text-violet-300",
};

function toneOf(tone?: string) {
  return (tone && TONES[tone]) ?? "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300";
}

export function Badge({
  children,
  tone,
  dot,
  className,
  ...rest
}: {
  children: React.ReactNode;
  tone?: string;
  dot?: boolean;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-5 ring-1 ring-inset backdrop-blur",
        toneOf(tone),
        className
      )}
      {...rest}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Status badge: shows the Arabic label of an API enum value. */
export function StatusBadge({
  value,
  dot,
  className,
}: {
  value: string | null | undefined;
  dot?: boolean;
  className?: string;
}) {
  return <Badge tone={value ?? undefined} dot={dot} className={className}>{label(value)}</Badge>;
}
