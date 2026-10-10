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
    brand: "from-brand-500/15 to-brand-500/5 text-brand-600 dark:text-brand-300",
    emerald: "from-emerald-500/15 to-emerald-500/5 text-emerald-600 dark:text-emerald-300",
    amber: "from-amber-500/15 to-amber-500/5 text-amber-600 dark:text-amber-300",
    sky: "from-sky-500/15 to-sky-500/5 text-sky-600 dark:text-sky-300",
    red: "from-red-500/15 to-red-500/5 text-red-600 dark:text-red-300",
  };
  const TrendIcon = trend?.dir === "up" ? TrendingUp : trend?.dir === "down" ? TrendingDown : Minus;
  return (
    <div
      className={cn(
        "glass group rounded-2xl p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glass",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {icon && (
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ring-1 ring-inset ring-white/20", tones[tone])}>
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
