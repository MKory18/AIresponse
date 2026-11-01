"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, Check, ChevronDown, Facebook, Info, Lightbulb, Paperclip, Search, Send, Smile, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { label, t } from "@/lib/i18n";
import { Avatar } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog, ErrorState } from "../ui/confirm";
import { Dialog, Drawer } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { Input, Select } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { useToast } from "../ui/toast";
import { ConversationItem, ConversationListEmpty, ConversationListSkeleton } from "./conversation-item";
import { CustomerPanel } from "./customer-panel";
import { MediaPicker } from "./MediaPicker";
import { DateSeparator, MessageBubble } from "./message-bubble";
import {
  CHANNEL_LABELS,
  avatarOf,
  displayNameOf,
  pageNameOf,
  type AssignmentActivity,
  type ConversationListItem,
  type CustomerDetail,
  type DraftInfo,
  type MessageItem,
  type OpenHandoff,
} from "./types";

const FILTERS = [
  { key: "all", label: t.inbox.filterAll },
  { key: "unread", label: t.inbox.filterUnread },
  { key: "ai", label: t.inbox.filterAi },
  { key: "human", label: t.inbox.filterHuman },
  { key: "review", label: t.inbox.filterNeedsReview },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const HANDOFF_REASONS: Record<string, string> = {
  CUSTOMER_REQUEST: "طلب العميل",
  COMPLAINT: "شكوى",
  LOW_CONFIDENCE: "ثقة منخفضة",
  AI_FAILURE: "تعطل الذكاء",
  ORDER_BLOCKED: "طلب محظور",
  PAYMENT_ISSUE: "مشكلة دفع",
  INJECTION_DETECTED: "محاولة حقن",
  REPEATED_FAILURE: "فشل متكرر",
  MANUAL: "يدوي",
};

const ACTIVITY_LABELS: Record<string, string> = {
  "conversation.assigned": "إسناد",
  "conversation.unassigned": "إلغاء إسناد",
  "conversation.takeover": "استلام الموظف",
  "conversation.released_to_ai": "إعادة للذكاء",
  "conversation.review_requested": "طلب مراجعة",
  "conversation.ai_failed": "تعطل الذكاء",
  "note.created": "ملاحظة داخلية",
};

export default function Inbox() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  // P4 server-side filters (empty = all).
  const [statusSel, setStatusSel] = useState("");
  const [pageSel, setPageSel] = useState("");
  const [pages, setPages] = useState<{ id: string; label: string }[]>([]);
  const [assigneeSel, setAssigneeSel] = useState("");
  const [channelSel, setChannelSel] = useState("");
  const [openHandoff, setOpenHandoff] = useState<OpenHandoff>(null);
  const [activity, setActivity] = useState<AssignmentActivity[]>([]);
  const [composerTab, setComposerTab] = useState<"reply" | "note">("reply");
  const [noteBusy, setNoteBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [orderDraftCard, setOrderDraftCard] = useState<DraftInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const [actingTakeover, setActingTakeover] = useState(false);
  const [acting, setActing] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachData, setCoachData] = useState<any>(null);
  const [coachError, setCoachError] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Guards against stale responses: a slow poll/switch must never overwrite
  // newer state (switching threads or changing filters mid-flight).
  const listSeq = useRef(0);
  const msgSeq = useRef(0);
  const toast = useToast();
  // Load connected pages/channels for the page filter.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/channels")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.channels) return;
        setPages(
          (data.channels as Array<{ id: string; displayName?: string | null; externalId?: string | null; type?: string }>).map((c) => ({
            id: c.id,
            label: c.displayName || c.externalId || c.type || c.id,
          }))
        );
      })
      .catch(() => {
        /* channels list is optional for filtering; ignore failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadDraft(conversationId: string) {
    const res = await fetch(`/api/order-drafts?conversationId=${conversationId}`);
    if (res.ok) {
      const data = await res.json();
      setOrderDraftCard(data.items[0] ?? null);
    } else {
      setOrderDraftCard(null);
    }
  }

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  const fetchList = useCallback(
    async (opts?: { append?: boolean; cursor?: string | null; signal?: AbortSignal }) => {
      const seq = ++listSeq.current;
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (filter === "unread") params.set("unreadOnly", "true");
      if (statusSel) params.set("status", statusSel);
      if (pageSel) params.set("channelId", pageSel);
      if (assigneeSel) params.set("assignee", assigneeSel);
      if (channelSel) params.set("channelType", channelSel);
      if (opts?.cursor) params.set("cursor", opts.cursor);
      const res = await fetch(`/api/conversations?${params}`, { signal: opts?.signal });
      if (!res.ok) {
        if (seq === listSeq.current) setListError(t.inbox.loadListFailed);
        return;
      }
      const data = (await res.json()) as { items: ConversationListItem[]; nextCursor: string | null };
      if (seq !== listSeq.current) return; // a newer request superseded this one
      setListError(null);
      let items = data.items;
      if (filter === "ai") items = items.filter((c) => c.aiState !== "HUMAN_ACTIVE");
      if (filter === "human") items = items.filter((c) => c.aiState === "HUMAN_ACTIVE");
      if (filter === "review") items = items.filter((c) => c.hasOpenHandoff);
      setConversations((prev) => {
        const merged = opts?.append ? [...prev, ...items] : items;
        const seen = new Set<string>();
        return merged.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
      });
      setCursor(data.nextCursor);
    },
    [query, filter, statusSel, pageSel, assigneeSel, channelSel]
  );

  // Initial load + filter changes (debounced)
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      fetchList({ signal: controller.signal }).finally(() => setLoading(false));
    }, query ? 300 : 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchList]);

  // 20s polling
  useEffect(() => {
    const interval = setInterval(() => {
      fetchList();
      if (selectedId) refreshMessages(selectedId);
    }, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchList, selectedId]);

  const refreshMessages = useCallback(async (conversationId: string) => {
    const seq = ++msgSeq.current;
    const res = await fetch(`/api/conversations/${conversationId}/messages`);
    if (!res.ok || seq !== msgSeq.current) return;
    const data = (await res.json()) as { items: MessageItem[] };
    if (seq !== msgSeq.current) return;
    setMessages((prev) => {
      // Preserve unconfirmed optimistic rows (PENDING/QUEUED/FAILED) across
      // polls — the server list alone would silently wipe them before the
      // user sees the failure or the retry resolves.
      const pendingLocal = prev.filter(
        (m) => m.id.startsWith("optimistic-") && (m.deliveryStatus === "PENDING" || m.deliveryStatus === "QUEUED" || m.deliveryStatus === "FAILED")
      );
      return [...data.items, ...pendingLocal];
    });
  }, []);

  // Load thread + customer panel on selection
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setOpenHandoff(null);
    setActivity([]);
    setMessagesLoading(true);
    (async () => {
      try {
        const [msgRes, custRes] = await Promise.all([
          fetch(`/api/conversations/${selectedId}/messages`),
          fetch(`/api/conversations/${selectedId}`),
        ]);
        if (cancelled) return;
        if (msgRes.ok) setMessages(((await msgRes.json()) as { items: MessageItem[] }).items);
        if (custRes.ok) {
          const conv = (await custRes.json()) as {
            customerId: string;
            openHandoff?: OpenHandoff;
            assignmentHistory?: AssignmentActivity[];
          };
          setOpenHandoff(conv.openHandoff ?? null);
          setActivity(conv.assignmentHistory ?? []);
          const customerRes = await fetch(`/api/customers/${conv.customerId}`);
          if (cancelled) return;
          if (customerRes.ok) setCustomer((await customerRes.json()) as CustomerDetail);
          loadDraft(selectedId);
        }
        // optimistic read
        setConversations((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, unreadCount: 0 } : c))
        );
        void fetch(`/api/conversations/${selectedId}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isRead: true }),
        }).catch(() => {
          /* unread flag restores on next poll if the request failed */
        });
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function send(pickedMediaId?: string) {
    if (!selectedId || (!draft.trim() && !pickedMediaId)) return;
    const text = draft.trim();
    // Client-generated idempotency key: double-click/double-POST resends the
    // SAME row instead of creating a duplicate outbound message.
    const idempotencyKey = `human-ui:${selectedId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    setSending(true);
    const optimistic: MessageItem = {
      id: `optimistic-${Date.now()}`,
      senderType: "HUMAN",
      direction: "OUTBOUND",
      type: pickedMediaId ? "IMAGE" : "TEXT",
      text: text || null,
      mediaUrl: null,
      deliveryStatus: "PENDING",
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");
    try {
      const res = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(text ? { text } : {}), ...(pickedMediaId ? { mediaId: pickedMediaId } : {}), idempotencyKey }),
      });
      const data = (await res.json().catch(() => ({}))) as MessageItem & { deliveryStatus?: string };
      if (!res.ok) throw new Error((data as { message?: string }).message ?? "");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimistic.id
            ? { ...m, id: (data as MessageItem).id ?? m.id, deliveryStatus: data.deliveryStatus ?? "SENT" }
            : m
        )
      );
      if (data.deliveryStatus === "QUEUED") toast.show(t.delivery.sending, "info");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 30);
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, deliveryStatus: "FAILED" } : m)));
      toast.show(t.delivery.sendFailed, "error");
    } finally {
      setSending(false);
    }
  }

  async function retryMessage(m: MessageItem) {
    // FAILED always retryable; PENDING/QUEUED retryable too so a message stuck
    // in "sending" can be recovered manually (server reuses the idempotency row).
    if (!selectedId || (m.deliveryStatus !== "FAILED" && m.deliveryStatus !== "QUEUED" && m.deliveryStatus !== "PENDING")) return;
    // Optimistic retry under the SAME idempotency identity — the server reuses
    // the row, so Meta never receives a duplicate.
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, deliveryStatus: "QUEUED" } : x)));
    try {
      const res = await fetch(`/api/conversations/${selectedId}/messages/${m.id}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { deliveryStatus?: string };
      if (!res.ok) throw new Error();
      setMessages((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, deliveryStatus: data.deliveryStatus ?? "SENT" } : x))
      );
    } catch {
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, deliveryStatus: "FAILED" } : x)));
      toast.show(t.delivery.sendFailed, "error");
    }
  }

  async function sendNote() {
    if (!selectedId || !draft.trim()) return;
    const text = draft.trim();
    setNoteBusy(true);
    try {
      // Team-only endpoint: the row is flagged isNote and can never enter
      // ChannelSender (no send, no retry, no sweep — enforced server-side).
      const res = await fetch(`/api/conversations/${selectedId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { note: MessageItem };
      setMessages((prev) => [...prev, { ...data.note, isNote: true }]);
      setDraft("");
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setNoteBusy(false);
    }
  }

  async function removeConversation() {
    if (!selectedId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/conversations/${selectedId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      const gone = selectedId;
      setConversations((prev) => prev.filter((c) => c.id !== gone));
      setSelectedId(null);
      setMessages([]);
      setCustomer(null);
      setOrderDraftCard(null);
      setConfirmDelete(false);
      toast.show(t.inbox.deleteConversationDone, "success");
    } catch {
      toast.show(t.inbox.deleteConversationFailed, "error");
    } finally {
      setDeleting(false);
    }
  }

  async function action(path: string, body?: unknown) {
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/conversations/${selectedId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error();
      await refreshSelected();
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    }
  }

  async function refreshSelected() {
    if (!selectedId) return;
    await Promise.all([fetchList(), refreshMessages(selectedId)]);
  }

  async function resolve() {
    if (!selectedId || acting) return;
    setActing(true);
    try {
      const res = await fetch(`/api/conversations/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "RESOLVED" }),
      });
      if (!res.ok) throw new Error();
      await refreshSelected();
      toast.show(t.inbox.resolve, "success");
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setActing(false);
    }
  }

  // P8 — مساعد البيع: اقتراحات داخلية فقط، لا يُرسل شيء تلقائيًا.
  async function loadCoach(conversationId: string) {
    setCoachLoading(true);
    setCoachError(false);
    try {
      // OCR-2026-10-16 #9: body فاضي كان باربع INVALID_BODY دايمًا — المسار
      // لازم JSON (حتى {}) لأنه schema strict. بلا هالسطر الميزة كانت
      // مطفية من الواجهة كليًا رغم اختبارات المسار الخضرا (بيز body).
      const res = await fetch(`/api/conversations/${conversationId}/coach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error();
      const json = await res.json();
      setCoachData(json.data ?? null);
    } catch {
      // فشل واضح ≠ فراغ: لا نعرض "لا اقتراحات" حين يكون الطلب فاشلًا.
      setCoachData(null);
      setCoachError(true);
    } finally {
      setCoachLoading(false);
    }
  }

  const unreadTotal = conversations.reduce((a, c) => a + c.unreadCount, 0);
  const isFiltered = Boolean(query) || filter !== "all" || Boolean(statusSel || pageSel || assigneeSel || channelSel);
  const aiMode = selected?.aiState !== "HUMAN_ACTIVE";

  // Pick up ?q= from the topbar search, and ?id= from links that point at one
  // conversation (التحويلات · صفحة الطلب) — بتنفتح مباشرة بدل الوارد العام.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q");
      if (q) setQuery(q);
      const id = params.get("id");
      if (id) setSelectedId(id);
    } catch { /* ignore */ }
  }, []);

  return (
    <div className="flex h-[calc(100dvh-4rem-var(--shell-extra,0px))] gap-3">
      {/* Conversation list — glass panel */}
      <aside
        className={cn(
          "glass flex w-80 shrink-0 flex-col overflow-hidden rounded-2xl max-lg:w-full",
          selectedId && "max-lg:hidden"
        )}
      >
        <div className="space-y-2.5 border-b border-line/60 p-3">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.inbox.searchPlaceholder}
              aria-label={t.common.search}
              className="h-10 ps-9 text-[13px]"
            />
          </div>
          <div className="flex items-center gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label={t.inbox.title}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all",
                  filter === f.key
                    ? "bg-primary text-white shadow-xs"
                    : "text-ink-muted hover:bg-surface-3 hover:text-ink"
                )}
              >
                {f.label}
                {f.key === "unread" && unreadTotal > 0 && (
                  <span className="num rounded-full bg-white/25 px-1.5 text-[10px] font-bold">{unreadTotal}</span>
                )}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Select value={statusSel} onChange={(e) => setStatusSel(e.target.value)} aria-label="الحالة" className="h-9 text-xs">
              <option value="">كل الحالات</option>
              <option value="OPEN">مفتوحة</option>
              <option value="PENDING">معلقة</option>
              <option value="RESOLVED">محلولة</option>
              <option value="CLOSED">مغلقة</option>
            </Select>
            <Select value={pageSel} onChange={(e) => setPageSel(e.target.value)} aria-label="الصفحة" className="h-9 text-xs">
              <option value="">كل الصفحات</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Select value={assigneeSel} onChange={(e) => setAssigneeSel(e.target.value)} aria-label="الإسناد" className="h-9 text-xs">
              <option value="">كل الموظفين</option>
              <option value="me">مُسندة إليّ</option>
              <option value="none">غير مُسندة</option>
            </Select>
            <Select value={channelSel} onChange={(e) => setChannelSel(e.target.value)} aria-label="القناة" className="h-9 text-xs">
              <option value="">كل القنوات</option>
              {Object.entries(CHANNEL_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2" role="listbox" aria-label={t.inbox.title}>
          {loading && <ConversationListSkeleton />}
          {listError && (
            <div className="p-4 text-center">
              <p className="text-xs text-red-600 dark:text-red-400">{listError}</p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => fetchList()}>
                {t.common.retry}
              </Button>
            </div>
          )}
          {!loading && !listError && conversations.length === 0 && (
            <ConversationListEmpty isFiltered={isFiltered} />
          )}
          {!loading &&
            conversations.map((c) => (
              <ConversationItem
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={setSelectedId}
              />
            ))}
          {cursor && !loading && (
            <Button variant="ghost" size="sm" className="mx-auto my-2 flex" onClick={() => fetchList({ append: true, cursor })}>
              {t.common.loadMore}
              <ChevronDown size={13} />
            </Button>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section
        className={cn(
          "glass min-w-0 flex-1 flex-col overflow-hidden rounded-2xl max-lg:w-full",
          selectedId ? "flex" : "hidden lg:flex"
        )}
      >
        {!selected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="glass-subtle flex h-16 w-16 items-center justify-center rounded-2xl text-brand-500">
              <Search size={24} strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <p className="text-sm font-bold text-ink">{t.inbox.selectConversation}</p>
              <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-ink-muted">{t.inbox.selectHint}</p>
            </div>
          </div>
        ) : (
          <>
            <header className="glass-subtle z-10 flex flex-wrap items-center justify-between gap-2 rounded-none border-x-0 border-t-0 px-3 py-2.5 sm:px-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  onClick={() => setSelectedId(null)}
                  aria-label={t.common.back}
                  className="rounded-xl p-2 text-ink-muted transition hover:bg-surface-3 hover:text-ink lg:hidden"
                >
                  <ArrowRight size={17} />
                </button>
                <Avatar name={displayNameOf(selected) ?? selected.customer.phone} src={avatarOf(selected)} size="sm" ring />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">
                    {displayNameOf(selected) ?? t.inbox.unknownCustomer}
                  </p>
                  <p className="flex min-w-0 items-center gap-1 text-[11px] text-ink-muted">
                    {pageNameOf(selected) ? (
                      <span className="flex min-w-0 items-center gap-1 font-semibold text-brand-600 dark:text-brand-300">
                        <Facebook size={11} className="shrink-0" />
                        <span className="truncate">{pageNameOf(selected)}</span>
                      </span>
                    ) : (
                      <span>{CHANNEL_LABELS[selected.channel.type] ?? selected.channel.type}</span>
                    )}
                    <span className="shrink-0">· {label(selected.customer.status)}</span>
                    {selected.assignedAgent && <span className="truncate">· {selected.assignedAgent.name}</span>}
                  </p>
                  {selected.aiPersona && (
                    <p className="mt-0.5 truncate text-[11px] text-ink-subtle">
                      {t.inbox.aiPersonaLabel}: <span className="font-semibold text-ink-muted">{selected.aiPersona.name}</span>
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={aiMode ? "AI_ACTIVE" : "HUMAN_ACTIVE"} dot>
                  <Bot size={11} />
                  {aiMode ? t.inbox.replyWithAi : t.inbox.replyManually}
                </Badge>
                {aiMode ? (
                  <Button size="sm" variant="secondary" onClick={() => setConfirmTakeover(true)}>
                    <Sparkles size={13} /> {t.inbox.takeOver}
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => action("release-ai")} disabled={acting} loading={acting}>
                    <Bot size={13} /> {t.inbox.backToAi}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setCoachOpen(true);
                    if (selectedId && !coachData) void loadCoach(selectedId);
                  }}
                >
                  <Lightbulb size={13} /> مساعد البيع
                </Button>
                <Button size="sm" variant="success" onClick={resolve} disabled={acting} loading={acting}>
                  <Check size={13} /> {t.inbox.resolve}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPanelOpen(true)}
                  aria-label="معلومات العميل"
                  className="xl:hidden"
                >
                  <Info size={13} /> ملف العميل
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(true)}
                  className="text-red-600 hover:bg-red-500/10 dark:text-red-400"
                >
                  <Trash2 size={13} /> {t.inbox.deleteConversation}
                </Button>
              </div>
            </header>

            {openHandoff && (
              <div className="border-b border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-400/20 dark:text-amber-300 sm:px-4">
                <span className="font-bold">بانتظار موظف: </span>
                {HANDOFF_REASONS[openHandoff.reason] ?? openHandoff.reason}
                <span className="text-amber-700/80 dark:text-amber-400/80"> · {openHandoff.status === "CLAIMED" ? "مُستلمة" : "مفتوحة"}</span>
              </div>
            )}
            {activity.length > 0 && (
              <details className="border-b border-line/60 px-3 py-1.5 text-[11px] text-ink-subtle sm:px-4">
                <summary className="cursor-pointer font-semibold">سجل المحادثة ({activity.length})</summary>
                <ul className="mt-1.5 space-y-1">
                  {activity.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <span>
                        {ACTIVITY_LABELS[a.action] ?? a.action}
                        {a.actorName ? ` · ${a.actorName}` : ""}
                      </span>
                      <span className="num shrink-0">{new Date(a.createdAt).toLocaleDateString("ar")}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-5">
              {messagesLoading && messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <Skeleton className="h-20 w-2/3 rounded-2xl" />
                </div>
              ) : !messagesLoading && messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <EmptyState illustration="/brand/empty-conversations.webp" title="لا رسائل بعد" description="ستظهر رسائل هذه المحادثة هنا بمجرد وصولها." />
                </div>
              ) : (
                messages.map((m, i) => {
                  const prev = messages[i - 1];
                  const newDay =
                    !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
                  return (
                      <div key={m.id}>
                      {newDay && (
                        <DateSeparator
                          day={new Date(m.createdAt).toLocaleDateString("ar", { weekday: "long", day: "numeric", month: "long" })}
                        />
                      )}
                      <MessageBubble message={m} onRetry={retryMessage} />
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            <footer className="border-t border-line bg-surface-2 p-3">
              <div className="mb-1.5 flex gap-1" role="tablist" aria-label="نوع الرسالة">
                <button
                  role="tab"
                  aria-selected={composerTab === "reply"}
                  onClick={() => setComposerTab("reply")}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all",
                    composerTab === "reply" ? "bg-primary-soft text-primary" : "text-ink-muted hover:bg-surface-3 hover:text-ink"
                  )}
                >
                  رد للعميل
                </button>
                <button
                  role="tab"
                  aria-selected={composerTab === "note"}
                  onClick={() => setComposerTab("note")}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all",
                    composerTab === "note" ? "bg-amber-500 text-white shadow-xs" : "text-ink-muted hover:bg-surface-3 hover:text-ink"
                  )}
                  title="ملاحظة داخلية للفريق — لا تُرسل للعميل أبدًا"
                >
                  ملاحظة داخلية
                </button>
              </div>
              <div
                className={cn(
                  "glass-subtle flex items-end gap-1.5 rounded-2xl p-1.5 transition-shadow",
                  composerTab === "note" && "bg-amber-500/[0.06] ring-2 ring-amber-500/40"
                )}
              >
                <div className="flex gap-0.5 pb-0.5">
                  <button
                    aria-label={t.inbox.attach}
                    title="أرسل من المكتبة"
                    disabled={composerTab !== "reply" || sending}
                    onClick={() => setPickerOpen(true)}
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-ink-subtle transition hover:bg-surface-3 hover:text-ink disabled:opacity-40"
                  >
                    <Paperclip size={16} />
                  </button>
                  <button
                    aria-label={t.inbox.emoji}
                    title={`${t.inbox.emoji} (قريبًا)`}
                    disabled
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-ink-subtle transition hover:bg-surface-3 hover:text-ink disabled:opacity-40"
                  >
                    <Smile size={16} />
                  </button>
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (composerTab === "note") void sendNote();
                      else void send();
                    }
                  }}
                  rows={1}
                  placeholder={composerTab === "note" ? "ملاحظة للفريق فقط — لن يراها العميل…" : t.inbox.composerPlaceholder}
                  aria-label={composerTab === "note" ? "ملاحظة داخلية" : t.inbox.replyManually}
                  className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-subtle"
                />
                <Button
                  onClick={() => (composerTab === "note" ? void sendNote() : void send())}
                  disabled={sending || noteBusy || !draft.trim()}
                  loading={sending || noteBusy}
                  size="icon"
                  aria-label={composerTab === "note" ? "إضافة ملاحظة" : t.common.send}
                  className="h-10 w-10 shrink-0 rounded-xl"
                >
                  {!(sending || noteBusy) && <Send size={16} className="-scale-x-100" />}
                </Button>
              </div>
              <p className="mt-1.5 px-1 text-[10px] text-ink-subtle">Enter {t.common.send} · Shift+Enter {t.inbox.newLine}</p>
            </footer>
            {/* Send from the library: the photo travels with the draft text
                through the normal human-reply door — policy, idempotency
                and channel rules all still apply. */}
            <MediaPicker
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onPick={(mediaId) => {
                setPickerOpen(false);
                void send(mediaId);
              }}
            />
          </>
        )}
      </section>

      {/* Customer panel — glass (desktop) + Drawer (small screens — P11) */}
      <aside className="glass hidden w-72 shrink-0 overflow-y-auto rounded-2xl xl:block">
        <CustomerPanel
          customer={customer}
          orderDraft={orderDraftCard}
          pageName={selected ? pageNameOf(selected) : null}
        />
      </aside>
      <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} side="end" until="xl" title="ملف العميل">
        <div className="overflow-y-auto">
          <CustomerPanel
            customer={customer}
            orderDraft={orderDraftCard}
            pageName={selected ? pageNameOf(selected) : null}
          />
        </div>
      </Drawer>

      <Dialog open={coachOpen} onClose={() => setCoachOpen(false)} title="مساعد البيع" className="max-w-lg">
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-ink-subtle">اقتراحات داخلية فقط — لا يُرسل شيء للعميل تلقائيًا.</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => selectedId && void loadCoach(selectedId)}
            disabled={coachLoading}
          >
            تحديث
          </Button>
        </div>
        {coachLoading ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : coachError ? (
          <ErrorState className="py-6" title="تعذّر جلب الاقتراحات" onRetry={() => selectedId && void loadCoach(selectedId)} />
        ) : !coachData ? (
          <p className="mt-4 text-sm text-ink-muted">لا توجد اقتراحات الآن.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {(coachData.suggestions ?? []).map(
              (
                s: any,
                i: number
              ) => (
                <div key={i} className="rounded-xl border border-line/60 bg-surface-2/50 p-3">
                  <p className="text-[11px] font-bold text-brand-600 dark:text-brand-300">
                    {s.kind === "OBJECTION" ? "معالجة اعتراض" : s.kind === "DISCOUNT" ? "خصم" : s.kind === "CROSS_SELL" ? "بيع مُكمِّل" : s.kind === "OFFER" ? "عرض" : "تلميح رد"}
                    {s.reason ? ` · ${s.reason}` : ""}
                  </p>
                  {s.draftText ? (
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{s.draftText}</p>
                  ) : null}
                  {s.draftText ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2"
                      onClick={() => {
                        setComposerTab("reply");
                        setDraft(s.draftText);
                        setCoachOpen(false);
                      }}
                    >
                      إدراج في المحرر
                    </Button>
                  ) : null}
                </div>
              )
            )}
            {coachData.noOfferReason ? (
              <p className="text-[11px] text-ink-subtle">لا يوجد عرض: {coachData.noOfferReason}</p>
            ) : null}
          </div>
        )}
        <div className="mt-4 flex justify-start">
          <Button size="sm" variant="secondary" onClick={() => setCoachOpen(false)}>
            إغلاق
          </Button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmTakeover}
        onClose={() => setConfirmTakeover(false)}
        onConfirm={() => {
          setActingTakeover(true);
          action("takeover").finally(() => {
            setActingTakeover(false);
            setConfirmTakeover(false);
          });
        }}
        title={t.inbox.takeOverConfirmTitle}
        body={t.inbox.takeOverConfirmBody}
        confirmLabel={t.inbox.takeOverTitle}
        busy={actingTakeover}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void removeConversation()}
        title={t.inbox.deleteConversationTitle}
        body={t.inbox.deleteConversationBody}
        confirmLabel={t.inbox.deleteConversation}
        busy={deleting}
        danger
      />
    </div>
  );
}
