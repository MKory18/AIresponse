"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Info, Lightbulb, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api-client";
import { Can, useCan } from "@/components/auth/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Menu } from "@/components/ui/menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { DateTime } from "@/components/ui/formatted";
import { CHANNEL_LABELS, avatarOf, displayNameOf, pageNameOf, type ConversationListItem, type MessageItem, type OpenHandoff } from "@/components/inbox/types";
import { Bubble } from "./bubble";
import { Composer } from "./composer";
import { CoachDialog } from "./coach-dialog";
import { whoReplies } from "./model";

const HANDOFF_REASONS: Record<string, string> = {
  CUSTOMER_REQUEST: "العميل بدّه موظف",
  COMPLAINT: "شكوى",
  LOW_CONFIDENCE: "الوكيل مش متأكد",
  AI_FAILURE: "الوكيل تعطّل",
  ORDER_BLOCKED: "طلب موقوف",
  PAYMENT_ISSUE: "مشكلة دفع",
  REPEATED_FAILURE: "فشل متكرر",
  MANUAL: "يدوي",
  ORDER_CHANGE_REQUEST: "طلب تعديل على طلب مثبّت",
};

/**
 * المحادثة (3.1): رأس بمفتاح واحد `[الوكيل يرد | أنا أرد]` (بدل شارتين وزر وحوار) — التبديل بلا تأكيد لأنه قابل
 * للتراجع بكبسة · قائمة «⋯» (أنهِ · اقتراحات رد · حذف الخطِر آخرها) · شريحة «يحتاجك» · الرسائل · المؤلّف.
 */
export function ThreadPane({
  conversation,
  messages,
  loading,
  error,
  openHandoff,
  draft,
  setDraft,
  onSend,
  onNote,
  onRetry,
  onBack,
  onOpenPanel,
  onChanged,
  onDeleted,
  className,
}: {
  conversation: ConversationListItem | null;
  messages: MessageItem[];
  loading: boolean;
  error: string | null;
  openHandoff: OpenHandoff;
  draft: string;
  setDraft: (v: string) => void;
  onSend: (text: string, mediaId?: string) => Promise<boolean>;
  onNote: (text: string) => Promise<boolean>;
  onRetry: (m: MessageItem) => void;
  onBack: () => void;
  onOpenPanel: () => void;
  onChanged: () => void;
  onDeleted: (id: string) => void;
  className?: string;
}) {
  const toast = useToast();
  const can = useCan();
  const bottom = useRef<HTMLDivElement>(null);
  const [coachOpen, setCoachOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  // المفتاح بيتحرك فورًا (تفاؤلي) وبيرجع لحاله إذا فشل — الخادم هو الحكم.
  const [pending, setPending] = useState<"agent" | "human" | null>(null);

  // انزل لآخر رسالة عند فتح المحادثة وعند وصول رسالة جديدة.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation?.id, messages.length]);

  if (!conversation) {
    return (
      <section className={cn("hidden flex-1 items-center justify-center rounded-card border border-line bg-surface-2 lg:flex", className)}>
        <EmptyState title="اختر محادثة" description="اختر محادثة من القائمة لتقرأها وتردّ." />
      </section>
    );
  }
  const id = conversation.id;
  const who = whoReplies(conversation.aiState);

  async function act(path: string, ok: string, to: "agent" | "human") {
    setBusy(true);
    setPending(to);
    try {
      await api(`/api/conversations/${id}/${path}`, { method: "POST" });
      onChanged();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : ok, "error");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function end() {
    setBusy(true);
    try {
      await api(`/api/conversations/${id}`, { method: "PATCH", json: { status: "RESOLVED" } });
      toast.show("انتهت المحادثة", "success");
      onChanged();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذّر إنهاء المحادثة", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/api/conversations/${id}`, { method: "DELETE" });
      setConfirmDelete(false);
      toast.show("انحذفت المحادثة", "success");
      onDeleted(id);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "تعذّر حذف المحادثة", "error");
    } finally {
      setBusy(false);
    }
  }

  const name = displayNameOf(conversation) ?? "عميل";
  const page = pageNameOf(conversation) ?? CHANNEL_LABELS[conversation.channel.type] ?? conversation.channel.type;
  const canSwitch = can("conversations.takeover");

  return (
    <section className={cn("min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-surface-2", className)} data-thread>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <button type="button" onClick={onBack} aria-label="رجوع للقائمة" className="rounded-control p-2 text-ink-muted hover:bg-surface-hover lg:hidden">
            <ArrowRight size={18} />
          </button>
          <Avatar name={name} src={avatarOf(conversation)} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{name}</p>
            <p className="truncate text-xs text-ink-muted">{page}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl<"agent" | "human">
            label="مين بيرد"
            value={pending ?? who}
            onChange={(v) => {
              if (busy || !canSwitch || v === (pending ?? who)) return;
              void act(v === "human" ? "takeover" : "release-ai", "تعذّر التبديل", v);
            }}
            options={[
              { value: "agent", label: "الوكيل يرد" },
              { value: "human", label: "أنا أرد" },
            ]}
          />
          <Can permission="conversations.read">
            <button type="button" onClick={onOpenPanel} aria-label="ملف العميل وبطاقة الطلب" className="rounded-control p-2 text-ink-muted hover:bg-surface-hover xl:hidden">
              <Info size={18} />
            </button>
          </Can>
          <Menu
            items={[
              { key: "end", label: "أنهِ المحادثة", icon: <Check size={14} aria-hidden />, onSelect: () => void end(), disabled: busy || conversation.status === "RESOLVED" },
              { key: "coach", label: "اقتراحات رد", icon: <Lightbulb size={14} aria-hidden />, onSelect: () => setCoachOpen(true) },
              ...(can("conversations.delete") ? [{ key: "delete", label: "احذف المحادثة", icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => setConfirmDelete(true) }] : []),
            ]}
          />
        </div>
      </header>

      {!canSwitch && who === "agent" && <p className="border-b border-line px-4 py-1 text-xs text-ink-subtle">ما عندك صلاحية تستلم المحادثة من الوكيل.</p>}
      {openHandoff && (
        <div className="border-b border-line px-3 py-2 sm:px-4" data-handoff-banner>
          <Callout
            risk={`يحتاجك: ${HANDOFF_REASONS[openHandoff.reason] ?? openHandoff.reason}`}
            fix={openHandoff.status === "CLAIMED" ? "مستلمة — كمّل الرد وبعدها أنهِ المحادثة." : "اضغط «أنا أرد» لتستلمها. الوكيل بيضل يرد لحد ما تستلم."}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-5" aria-live="polite">
        {error && <p role="alert" className="text-center text-sm text-danger">{error}</p>}
        {loading && messages.length === 0 ? (
          <Skeleton className="mx-auto h-20 w-2/3" />
        ) : !loading && messages.length === 0 && !error ? (
          <EmptyState title="ما في رسائل بعد" description="رسائل المحادثة بتظهر هون لما توصل." />
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            return (
              <div key={m.id}>
                {newDay && (
                  <p className="py-2 text-center text-xs text-ink-subtle">
                    <DateTime value={m.createdAt} mode="date" />
                  </p>
                )}
                <Bubble message={m} onRetry={onRetry} />
              </div>
            );
          })
        )}
        <div ref={bottom} />
      </div>

      <Can permission="conversations.reply">
        <Composer draft={draft} setDraft={setDraft} onSend={onSend} onNote={onNote} />
      </Can>

      <CoachDialog
        open={coachOpen}
        conversationId={id}
        onClose={() => setCoachOpen(false)}
        onInsert={(t) => {
          setDraft(t);
          setCoachOpen(false);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
        title="حذف المحادثة؟"
        body="المحادثة بتختفي من القائمة. اللي انسجّل منها (طلبات · عملاء) بيضل."
        confirmLabel="احذف المحادثة"
        busy={busy}
        danger
      />
    </section>
  );
}
