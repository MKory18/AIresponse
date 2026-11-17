"use client";

import { Quote } from "lucide-react";
import { cn } from "@/lib/cn";

/** سمة الرسالة بالـDOM اللي بيمرّر لها `EvidenceLink` (فقاعة الرسالة لازم تحملها). */
export const MESSAGE_ATTR = "data-message-id";
export const MARK_ATTR = "data-evidence-mark";

/**
 * `EvidenceLink` — «من الرسالة» (2.1): دليل كل قيمة قرأها الوكيل. النقر بيمرّر للرسالة وبيعلّمها لثواني.
 * إذا الرسالة مش محمّلة (أقدم من اللي معروض) بينادي `onMissing` (مثلًا بيحمّل المزيد) بدل ما يفشل بصمت.
 */
export function EvidenceLink({
  messageId,
  label = "من الرسالة",
  onMissing,
  className,
}: {
  messageId: string;
  label?: string;
  onMissing?: (messageId: string) => void;
  className?: string;
}) {
  function go() {
    const el = document.querySelector<HTMLElement>(`[${MESSAGE_ATTR}="${CSS.escape(messageId)}"]`);
    if (!el) return onMissing?.(messageId);
    el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    el.setAttribute(MARK_ATTR, "true");
    window.setTimeout(() => el.removeAttribute(MARK_ATTR), 2500);
  }
  return (
    <button
      type="button"
      onClick={go}
      className={cn("inline-flex items-center gap-1 text-caption font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus", className)}
    >
      <Quote size={12} aria-hidden /> {label}
    </button>
  );
}
