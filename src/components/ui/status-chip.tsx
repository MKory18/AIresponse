import { AlertTriangle, CheckCircle2, Circle, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const TONES: readonly Tone[] = ["neutral", "info", "success", "warning", "danger"];

const STYLES: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-muted",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

const ICONS = { neutral: Circle, info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

/**
 * `StatusChip` — نبرات دلالية + أيقونة (2.1). بيحل محل `Badge tone="<اسم enum>"` (خريطة بتقع على الرمادي بصمت):
 * هون النبرة صريحة، والمعنى ما بيعتمد على اللون بس (الأيقونة + النص).
 */
export function StatusChip({
  tone = "neutral",
  children,
  icon = true,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  icon?: boolean;
  className?: string;
}) {
  const Icon = ICONS[tone];
  return (
    <span
      data-tone={tone}
      className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", STYLES[tone], className)}
    >
      {icon && <Icon size={12} aria-hidden />}
      {children}
    </span>
  );
}
