import { cn } from "@/lib/cn";
import { label } from "@/lib/i18n";

const TONES: Record<string, string> = {
  OPEN: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  PENDING: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  RESOLVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  CLOSED: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  NEW: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  CONFIRMED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  CONFIRMATION_PENDING: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  PROCESSING: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  OUT_FOR_DELIVERY: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  DELIVERED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  CANCELLED: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  FAILED: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  RETURNED: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  CONFIRMED_BY_CUSTOMER: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  CONFIRMED_BY_AGENT: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  DECLINED: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  URGENT: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  HIGH: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  NORMAL: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  LOW: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  CONNECTED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  DISCONNECTED: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  CONNECTING: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  IN_STOCK: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  OUT_OF_STOCK: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  RUNNING: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  SCHEDULED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  SENT: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  SKIPPED: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  PAID: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  UNPAID: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  COD: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
};

function toneOf(tone?: string) {
  return (tone && TONES[tone]) ?? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
}

export function Badge({
  children,
  tone,
  className,
}: {
  children: React.ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4",
        toneOf(tone),
        className
      )}
    >
      {children}
    </span>
  );
}

/** Status badge: shows the Arabic label of an API enum value. */
export function StatusBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return <Badge tone={value ?? undefined} className={className}>{label(value)}</Badge>;
}