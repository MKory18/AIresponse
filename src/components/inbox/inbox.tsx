"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, Check, ChevronDown, Paperclip, Search, Send, Smile, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { label, t } from "@/lib/i18n";
import { Avatar } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { useToast } from "../ui/toast";
import { ConversationItem, ConversationListEmpty, ConversationListSkeleton } from "./conversation-item";
import { CustomerPanel } from "./customer-panel";
import { DateSeparator, MessageBubble } from "./message-bubble";
import {
  CHANNEL_LABELS,
  type ConversationListItem,
  type CustomerDetail,
  type DraftInfo,
  type MessageItem,
} from "./types";

const FILTERS = [
  { key: "all", label: t.inbox.filterAll },
  { key: "unread", label: t.inbox.filterUnread },
  { key: "ai", label: t.inbox.filterAi },
  { key: "human", label: t.inbox.filterHuman },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

export default function Inbox() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [orderDraftCard, setOrderDraftCard] = useState<DraftInfo | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

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
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (filter === "unread") params.set("unreadOnly", "true");
      if (opts?.cursor) params.set("cursor", opts.cursor);
      const res = await fetch(`/api/conversations?${params}`, { signal: opts?.signal });
      if (!res.ok) {
        setListError(t.inbox.loadListFailed);
        return;
      }
      const data = (await res.json()) as { items: ConversationListItem[]; nextCursor: string | null };
      setListError(null);
      let items = data.items;
      if (filter === "ai") items = items.filter((c) => c.aiState !== "HUMAN_ACTIVE");
      if (filter === "human") items = items.filter((c) => c.aiState === "HUMAN_ACTIVE");
      setConversations((prev) => {
        const merged = opts?.append ? [...prev, ...items] : items;
        const seen = new Set<string>();
        return merged.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
      });
      setCursor(data.nextCursor);
    },
    [query, filter]
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
    const res = await fetch(`/api/conversations/${conversationId}/messages`);
    if (res.ok) {
      const data = (await res.json()) as { items: MessageItem[] };
      setMessages(data.items);
    }
  }, []);

  // Load thread + customer panel on selection
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      const [msgRes, custRes] = await Promise.all([
        fetch(`/api/conversations/${selectedId}/messages`),
        fetch(`/api/conversations/${selectedId}`),
      ]);
      if (cancelled) return;
      if (msgRes.ok) setMessages(((await msgRes.json()) as { items: MessageItem[] }).items);
      if (custRes.ok) {
        const conv = (await custRes.json()) as { customerId: string };
        const customerRes = await fetch(`/api/customers/${conv.customerId}`);
        if (customerRes.ok) setCustomer((await customerRes.json()) as CustomerDetail);
        loadDraft(selectedId);
      }
      // optimistic read
      setConversations((prev) =>
        prev.map((c) => (c.id === selectedId ? { ...c, unreadCount: 0 } : c))
      );
      fetch(`/api/conversations/${selectedId}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function send() {
    if (!selectedId || !draft.trim()) return;
    const text = draft.trim();
    setSending(true);
    const optimistic: MessageItem = {
      id: `optimistic-${Date.now()}`,
      senderType: "HUMAN",
      direction: "OUTBOUND",
      type: "TEXT",
      text,
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
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error();
      const saved = (await res.json()) as MessageItem;
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? saved : m)));
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, deliveryStatus: "FAILED" } : m)));
    } finally {
      setSending(false);
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
    if (!selectedId) return;
    const res = await fetch(`/api/conversations/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED" }),
    });
    if (res.ok) {
      toast.show(t.inbox.resolve, "success");
      await refreshSelected();
    }
  }

  const unreadTotal = conversations.reduce((a, c) => a + c.unreadCount, 0);
  const isFiltered = Boolean(query) || filter !== "all";
  const aiMode = selected?.aiState !== "HUMAN_ACTIVE";

  // Pick up ?q= from the topbar search.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("q");
      if (q) setQuery(q);
    } catch { /* ignore */ }
  }, []);

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-3">
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
                    ? "bg-gradient-to-b from-brand-400 to-brand-600 text-white shadow-xs"
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
                <Avatar name={selected.customer.name ?? selected.customer.phone} size="sm" ring />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">
                    {selected.customer.name ?? selected.customer.phone ?? "عميل"}
                  </p>
                  <p className="flex items-center gap-1 text-[11px] text-ink-muted">
                    {CHANNEL_LABELS[selected.channel.type] ?? selected.channel.type} · {label(selected.customer.status)}
                    {selected.assignedAgent && ` · ${selected.assignedAgent.name}`}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={aiMode ? "AI_ACTIVE" : "HUMAN_ACTIVE"} dot>
                  <Bot size={11} />
                  {aiMode ? t.inbox.replyWithAi : t.inbox.replyManually}
                </Badge>
                {aiMode ? (
                  <Button size="sm" variant="secondary" onClick={() => action("takeover")}>
                    <Sparkles size={13} /> {t.inbox.takeOver}
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => action("release-ai")}>
                    <Bot size={13} /> {t.inbox.backToAi}
                  </Button>
                )}
                <Button size="sm" variant="success" onClick={resolve}>
                  <Check size={13} /> {t.inbox.resolve}
                </Button>
              </div>
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-5">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <Skeleton className="h-20 w-2/3 rounded-2xl" />
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
                      <MessageBubble message={m} />
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            <footer className="border-t border-line/60 bg-surface-2/60 p-3 backdrop-blur-xl dark:bg-white/[0.02]">
              <div className="glass-subtle flex items-end gap-1.5 rounded-2xl p-1.5">
                <div className="flex gap-0.5 pb-0.5">
                  <button
                    aria-label={t.inbox.attach}
                    title={`${t.inbox.attach} (قريبًا)`}
                    disabled
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
                      void send();
                    }
                  }}
                  rows={1}
                  placeholder={t.inbox.composerPlaceholder}
                  aria-label={t.inbox.replyManually}
                  className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-subtle"
                />
                <Button
                  onClick={() => void send()}
                  disabled={sending || !draft.trim()}
                  loading={sending}
                  size="icon"
                  aria-label={t.common.send}
                  className="h-10 w-10 shrink-0 rounded-xl"
                >
                  {!sending && <Send size={16} className="-scale-x-100" />}
                </Button>
              </div>
              <p className="mt-1.5 px-1 text-[10px] text-ink-subtle">Enter {t.common.send} · Shift+Enter {t.inbox.newLine}</p>
            </footer>
          </>
        )}
      </section>

      {/* Customer panel — glass */}
      <aside className="glass hidden w-72 shrink-0 overflow-y-auto rounded-2xl xl:block">
        <CustomerPanel customer={customer} orderDraft={orderDraftCard} />
      </aside>
    </div>
  );
}
