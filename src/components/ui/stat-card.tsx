import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { cn } from "@/lib/cn";

export function StatCard({
  label,
  value,
  icon,
  tone = "brand",
  trend,
  hint,
  className,
}: {
  label: string;
  value: string | number | null | undefined;
  icon?: React.ReactNode;
  tone?: "brand" | "emerald" | "amber" | "sky" | "red";
  trend?: { dir: "up" | "down" | "flat"; text: string };
  hint?: string;
  className?: string;
}) {
  const tones: Record<string, string> = {
    brand: "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
    emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    sky: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    red: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  };
  const TrendIcon = trend?.dir === "up" ? TrendingUp : trend?.dir === "down" ? TrendingDown : Minus;
  return (
    <div
      className={cn(
        "glass group rounded-2xl p-4 transition-colors duration-150 hover:border-brand-300/70 dark:hover:border-brand-700",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {icon && (
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-black/[0.04] dark:ring-white/[0.06]", tones[tone])}>
            {icon}
          </div>
        )}
        {trend && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              trend.dir === "up" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
              trend.dir === "down" && "bg-red-500/10 text-red-600 dark:text-red-300",
              trend.dir === "flat" && "bg-slate-500/10 text-slate-500"
            )}
          >
            <TrendIcon size={13} />
            <span className="num">{trend.text}</span>
          </span>
        )}
      </div>
      <div className="mt-3">
        <p className="num text-2xl font-bold leading-8 tracking-tight text-ink">{value ?? "—"}</p>
        <p className="mt-1 truncate text-xs font-medium text-ink-muted">{label}</p>
        {hint && <p className="mt-0.5 truncate text-[11px] text-ink-subtle">{hint}</p>}
      </div>
    </div>
  );
}
