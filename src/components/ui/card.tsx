import { cn } from "@/lib/cn";

/** Base card — solid surface. */
export function Card({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-line bg-surface-2 shadow-card",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div>
        <h3 className="text-sm font-bold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** Flat Fluent surfaces (name kept for existing call sites). */
export function GlassCard({
  children,
  level = "glass",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { level?: "glass-subtle" | "glass" | "glass-strong" }) {
  return (
    <div className={cn("rounded-2xl", level, className)} {...props}>
      {children}
    </div>
  );
}

export function GlassPanel({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("glass overflow-hidden rounded-2xl", className)} {...props}>
      {children}
    </div>
  );
}

/** Page hero header: title + description + optional actions/search. */
export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    // `data-page-header`: مقبض للثيمات (الفاصل الزخرفي تحت العنوان) بلا ما نلمس كل صفحة.
    <div data-page-header className={cn("border-b border-line pb-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold leading-8 tracking-tight text-ink lg:text-[28px]">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
