"use client";

import { Bot, RotateCcw, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { DateTime } from "@/components/ui/formatted";
import type { MessageItem } from "@/components/inbox/types";

export const MESSAGE_KIND = (m: Pick<MessageItem, "senderType" | "direction" | "isNote">): "system" | "note" | "customer" | "agent" | "staff" =>
  m.senderType === "SYSTEM" ? "system" : m.isNote ? "note" : m.direction === "INBOUND" ? "customer" : m.senderType === "AI" ? "agent" : "staff";

/**
 * فقاعة الرسالة (3.1، 03 §5.2): **الوكيل والموظف بلونين مختلفين** — الوكيل `primary-soft` بوسم «الوكيل»،
 * الموظف `primary` باسمه. الرسالة اللي ما انبعتت: سطر أحمر تحتها + «أعد الإرسال». الملاحظة الداخلية بالتحذير ومعلّمة.
 * `data-message-id` = هدف «من الرسالة» (دليل القراءة).
 */
export function Bubble({ message: m, onRetry }: { message: MessageItem; onRetry: (m: MessageItem) => void }) {
  const kind = MESSAGE_KIND(m);
  if (kind === "system") {
    return (
      <div data-message-id={m.id} className="flex justify-center py-1">
        <span className="rounded-full bg-surface-3 px-3 py-0.5 text-xs text-ink-muted">{m.text}</span>
      </div>
    );
  }
  if (kind === "note") {
    return (
      <div data-message-id={m.id} data-kind="note" className="flex justify-center py-0.5">
        <div className="max-w-[85%] rounded-card border border-warning/40 bg-warning-soft px-3 py-2">
          <p className="mb-0.5 text-xs font-semibold text-warning">ملاحظة داخلية · للفريق فقط</p>
          <p className="whitespace-pre-wrap break-words text-sm text-ink">{m.text}</p>
          <DateTime value={m.createdAt} mode="time" className="mt-1 block text-xs text-ink-subtle" />
        </div>
      </div>
    );
  }
  const outbound = kind !== "customer";
  const failed = m.deliveryStatus === "FAILED";
  const sending = m.deliveryStatus === "PENDING" || m.deliveryStatus === "QUEUED";
  return (
    <div data-message-id={m.id} data-kind={kind} className={cn("flex w-full", outbound ? "justify-end" : "justify-start")}>
      <div className="max-w-[85%] sm:max-w-[68%]">
        <div
          className={cn(
            "rounded-card px-3 py-2 text-sm leading-relaxed data-[evidence-mark=true]:ring-2 data-[evidence-mark=true]:ring-focus",
            kind === "customer" && "bg-surface-3 text-ink",
            kind === "agent" && "bg-primary-soft text-ink",
            kind === "staff" && "bg-primary text-on-primary"
          )}
        >
          {outbound && (
            <p className={cn("mb-0.5 flex items-center gap-1 text-xs font-semibold", kind === "staff" ? "text-on-primary" : "text-primary")}>
              {kind === "agent" ? <Bot size={12} aria-hidden /> : <UserRound size={12} aria-hidden />}
              {kind === "agent" ? "الوكيل" : (m.senderName ?? "موظف")}
            </p>
          )}
          {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
          {m.mediaUrl && (
            <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-medium underline underline-offset-2">
              مرفق
            </a>
          )}
          <DateTime value={m.createdAt} mode="time" className={cn("mt-1 block text-xs", kind === "staff" ? "text-on-primary" : "text-ink-subtle")} />
        </div>
        {outbound && (failed || sending) && (
          <p className={cn("mt-1 flex items-center gap-2 text-xs", failed ? "font-semibold text-danger" : "text-ink-subtle")} role={failed ? "alert" : undefined}>
            {failed ? "ما انبعتت الرسالة" : "جاري الإرسال…"}
            <button type="button" onClick={() => onRetry(m)} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus">
              <RotateCcw size={12} aria-hidden /> أعد الإرسال
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
