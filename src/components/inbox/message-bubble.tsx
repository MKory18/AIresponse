"use client";

import { Bot, Check, CheckCheck, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTime, label, t } from "@/lib/i18n";
import type { MessageItem } from "./types";

/** Premium chat bubble: compact, elegant, clearly separated incoming/outgoing. */
export function MessageBubble({ message, onRetry }: { message: MessageItem; onRetry?: (m: MessageItem) => void }) {
  const m = message;
  const outbound = m.direction === "OUTBOUND";
  const system = m.senderType === "SYSTEM";

  if (system) {
    return (
      <div className="flex justify-center py-1">
        <span className="bubble-sys">{m.text}</span>
      </div>
    );
  }

  // P4: internal team note — amber, labeled, no delivery tick, no retry.
  // Notes never enter ChannelSender (server-enforced); the bubble only renders.
  if (m.isNote) {
    return (
      <div className="flex w-full justify-center py-0.5">
        <div className="max-w-[85%] rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 dark:border-amber-400/25">
          <p className="mb-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">ملاحظة داخلية · للفريق فقط</p>
          <p className="whitespace-pre-wrap break-words text-[13px] text-ink">{m.text}</p>
          <p className="num mt-1 text-[10px] text-ink-subtle">{formatTime(m.createdAt)}</p>
        </div>
      </div>
    );
  }

  return (
    // RTL: رسالة الموظف الصادرة إلى اليسار (نهاية السطر) ورسالة العميل إلى اليمين — عرف تطبيقات المحادثة العربية
    <div className={cn("flex w-full animate-fade-in", outbound ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[78%] sm:max-w-[62%]", outbound ? "bubble-out" : "bubble-in")}>
        {m.senderType === "AI" && !outbound && (
          <p className="mb-1 flex items-center gap-1 text-[10px] font-bold text-brand-600 dark:text-brand-300">
            <Bot size={11} />
            {t.roles.ai}
          </p>
        )}
        {m.type !== "TEXT" && (
          <p className={cn("mb-1 text-[10px] font-semibold", outbound ? "text-white/75" : "text-ink-subtle")}>
            {m.mediaUrl ? t.inbox.attachment : label(m.type)}
          </p>
        )}
        {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
        {m.mediaUrl && (
          <a
            href={m.mediaUrl}
            target="_blank"
            rel="noreferrer"
            className={cn("mt-1 inline-block text-[11px] font-medium underline underline-offset-2", outbound ? "text-white/90" : "text-brand-600 dark:text-brand-400")}
          >
            {t.inbox.attachment} ({label(m.type)})
          </a>
        )}
        <p className={cn("mt-1 flex items-center gap-1 text-[10px]", outbound ? "text-white/70" : "text-ink-subtle")}>
          <span className="num">{formatTime(m.createdAt)}</span>
          {outbound && (
            <span className="inline-flex items-center gap-0.5">
              ·
              {m.deliveryStatus === "FAILED" || m.deliveryStatus === "PENDING" || m.deliveryStatus === "QUEUED" ? (
                <span className="inline-flex items-center gap-1">
                  {m.deliveryStatus === "FAILED" ? t.delivery.failed : t.delivery.sending}
                  {onRetry && (
                    <button
                      onClick={() => onRetry(m)}
                      className="inline-flex items-center gap-0.5 font-bold underline underline-offset-2"
                    >
                      <RotateCcw size={11} />
                      {t.delivery.retry}
                    </button>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5">
                  <CheckCheck size={12} />
                  {t.delivery.sent}
                </span>
              )}
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
    <div className="flex items-center gap-3 py-2.5">
      <span className="h-px flex-1 bg-gradient-to-l from-transparent via-line to-transparent" />
      <span className="glass-subtle rounded-full px-3 py-0.5 text-[10px] font-semibold text-ink-muted">{day}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-line to-transparent" />
    </div>
  );
}

export function DeliveryTick({ status }: { status: string }) {
  if (status === "READ" || status === "DELIVERED" || status === "SENT") {
    return <CheckCheck size={13} className="text-brand-500" aria-label={status} />;
  }
  return <Check size={13} className="text-ink-subtle" aria-label={status} />;
}
