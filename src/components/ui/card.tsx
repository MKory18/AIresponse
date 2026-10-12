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
        "rounded-3xl border border-line bg-surface-2 shadow-card",
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

/** Glass levels: subtle / default / strong. */
export function GlassCard({
  children,
  level = "glass",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { level?: "glass-subtle" | "glass" | "glass-strong" }) {
  return (
    <div className={cn("rounded-3xl", level, className)} {...props}>
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
    <div className={cn("glass overflow-hidden rounded-3xl", className)} {...props}>
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
    <div className={cn("rounded-3xl bg-surface-2 px-5 py-4 shadow-card sm:px-6 sm:py-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-9 text-ink lg:text-[30px]">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
