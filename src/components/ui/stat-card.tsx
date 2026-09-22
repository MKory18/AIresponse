import { cn } from "@/lib/cn";

export function StatCard({
  label,
  value,
  icon,
  tone = "brand",
  className,
}: {
  label: string;
  value: string | number | null | undefined;
  icon?: React.ReactNode;
  tone?: "brand" | "emerald" | "amber" | "sky" | "red" | "violet";
  className?: string;
}) {
  const tones: Record<string, string> = {
    brand: "bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-300",
    emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300",
    amber: "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300",
    sky: "bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-300",
    red: "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-300",
    violet: "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300",
  };
  return (
    <div className={cn("flex items-center gap-3.5 rounded-xl2 border border-line bg-surface-2 p-4 shadow-card", className)}>
      {icon && (
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", tones[tone])}>
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-xs text-ink-muted">{label}</p>
        <p className="num mt-0.5 text-lg font-bold leading-6 text-ink">{value ?? "—"}</p>
      </div>
    </div>
  );
}