"use client";

import { cn } from "@/lib/cn";
import { formatTime, label, t } from "@/lib/i18n";
import type { MessageItem } from "./types";

/** Professional chat bubble: incoming left (RTL visual right for customer), outgoing brand-filled. */
export function MessageBubble({ message }: { message: MessageItem }) {
  const m = message;
  const outbound = m.direction === "OUTBOUND";
  const system = m.senderType === "SYSTEM";

  if (system) {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-surface-3 px-3 py-1 text-[11px] text-ink-muted">{m.text}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex w-full", outbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed shadow-xs sm:max-w-[60%]",
          outbound
            ? "rounded-br-md bg-brand-500 text-white"
            : "rounded-bl-md border border-line bg-surface-2 text-ink"
        )}
      >
        {m.type !== "TEXT" && (
          <p className={cn("mb-1 text-[10px] font-medium", outbound ? "text-white/70" : "text-ink-subtle")}>
            {m.mediaUrl ? t.inbox.attachment : label(m.type)}
          </p>
        )}
        {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
        {m.mediaUrl && (
          <a
            href={m.mediaUrl}
            target="_blank"
            rel="noreferrer"
            className={cn("mt-1 inline-block text-[11px] underline", outbound ? "text-white/90" : "text-brand-600 dark:text-brand-400")}
          >
            {t.inbox.attachment} ({label(m.type)})
          </a>
        )}
        <p className={cn("mt-1 flex items-center gap-1 text-[10px]", outbound ? "text-white/70" : "text-ink-subtle")}>
          <span>{formatTime(m.createdAt)}</span>
          {m.senderType === "AI" && <span>· {t.roles.ai}</span>}
          {outbound && m.senderType === "HUMAN" && (
            <span>
              · {m.deliveryStatus === "FAILED" ? "فشل الإرسال" : m.deliveryStatus === "PENDING" ? "جارٍ الإرسال…" : "أُرسلت"}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/** Day separator between message groups. */
export function DateSeparator({ day }: { day: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="h-px flex-1 bg-line" />
      <span className="text-[10px] font-medium text-ink-subtle">{day}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}