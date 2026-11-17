import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";

/** رسمة أعمدة وحدة بالتبويب: عمود لكل يوم بتوقيت المساحة، وارتفاعه نسبة من أعلى يوم. بلا مكتبة، وبأدوار الألوان بس. */
export function TrendChart({ label, points }: { label: string; points: Array<{ date: string; value: number }> }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((s, p) => s + p.value, 0);
  return (
    <section data-chart className="rounded-card border border-line bg-surface-2 p-5 shadow-raised">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-ink-muted">{label}</h3>
        <span className="text-caption tabular-nums text-ink-subtle">المجموع {formatNumber(total, 0)}</span>
      </div>
      {points.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">ما في أيام بالفترة.</p>
      ) : (
        <>
          <div role="img" aria-label={`${label}: ${points.map((p) => `${p.date} ${p.value}`).join("، ")}`} className="mt-4 flex h-32 items-end gap-1" dir="ltr">
            {points.map((p) => (
              <div key={p.date} title={`${p.date}: ${formatNumber(p.value, 0)}`} className="flex h-full min-w-0 flex-1 items-end">
                <div className={cn("w-full rounded-t-control", p.value > 0 ? "bg-primary" : "bg-surface-3")} style={{ height: `${p.value > 0 ? Math.max(4, (p.value / max) * 100) : 2}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-caption tabular-nums text-ink-subtle" dir="ltr">
            <span>{points[0]!.date}</span>
            <span>{points[points.length - 1]!.date}</span>
          </div>
        </>
      )}
    </section>
  );
}
