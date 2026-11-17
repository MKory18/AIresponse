import { AlertTriangle, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * `Callout` — بديل `RiskNote`/`FixNote` (2.1). قاعدة المالك بتضل: الخطر **أحمر «تنبيه»** وتحته التصحيح **برتقالي «الحل»**
 * (ما منلغي الميزة، منعلّمها). مضغوط، وقابل للطي بـ`collapsible` (يبدأ مفتوح)، وبلا أسماء متغيّرات لغير المالك.
 *
 * `<Callout risk="…" fix="…" />` بيرسم الزوج؛ `kind` لوحده بيرسم واحد.
 */
type Kind = "risk" | "fix";

const KIND = {
  risk: { title: "تنبيه", Icon: AlertTriangle, box: "border-danger/40 bg-danger-soft", head: "text-danger" },
  fix: { title: "الحل", Icon: Wrench, box: "border-warning/40 bg-warning-soft", head: "text-warning" },
} as const;

function One({ kind, children, collapsible, className }: { kind: Kind; children: React.ReactNode; collapsible?: boolean; className?: string }) {
  const k = KIND[kind];
  const head = (
    <span className={cn("flex items-center gap-1.5 text-sm font-semibold", k.head)}>
      <k.Icon size={14} aria-hidden /> {k.title}
    </span>
  );
  const body = <div className="mt-1 text-sm leading-relaxed text-ink">{children}</div>;
  return collapsible ? (
    <details open data-callout={kind} className={cn("rounded-card border px-3 py-2", k.box, className)}>
      <summary className="cursor-pointer list-none focus-visible:outline-2 focus-visible:outline-focus">{head}</summary>
      {body}
    </details>
  ) : (
    <div data-callout={kind} role={kind === "risk" ? "alert" : "note"} className={cn("rounded-card border px-3 py-2", k.box, className)}>
      {head}
      {body}
    </div>
  );
}

export function Callout({
  kind,
  risk,
  fix,
  children,
  collapsible = false,
  className,
}: {
  kind?: Kind;
  risk?: React.ReactNode;
  fix?: React.ReactNode;
  children?: React.ReactNode;
  collapsible?: boolean;
  className?: string;
}) {
  if (risk !== undefined || fix !== undefined) {
    return (
      <div className={cn("space-y-1.5", className)}>
        {risk !== undefined && <One kind="risk" collapsible={collapsible}>{risk}</One>}
        {fix !== undefined && <One kind="fix" collapsible={collapsible}>{fix}</One>}
      </div>
    );
  }
  return (
    <One kind={kind ?? "risk"} collapsible={collapsible} className={className}>
      {children}
    </One>
  );
}
