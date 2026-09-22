"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, MessageSquareText, Paperclip, Search, Send, Smile, Sparkles } from "lucide-react";
import { label, t } from "@/lib/i18n";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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

export default function Inbox() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
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
      if (unreadOnly) params.set("unreadOnly", "true");
      if (opts?.cursor) params.set("cursor", opts.cursor);
      const res = await fetch(`/api/conversations?${params}`, { signal: opts?.signal });
      if (!res.ok) {
        setListError(t.inbox.loadListFailed);
        return;
      }
      const data = (await res.json()) as { items: ConversationListItem[]; nextCursor: string | null };
      setListError(null);
      setConversations((prev) => {
        const merged = opts?.append ? [...prev, ...data.items] : data.items;
        const seen = new Set<string>();
        return merged.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
      });
      setCursor(data.nextCursor);
    },
    [query, unreadOnly]
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
      toast.show(t.inbox.resolve + " ✓", "success");
      await refreshSelected();
    }
  }

  const unreadTotal = conversations.reduce((a, c) => a + c.unreadCount, 0);
  const isFiltered = Boolean(query) || unreadOnly;

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* Conversation list */}
      <aside className="flex w-80 shrink-0 flex-col border-e border-line bg-surface-2 max-lg:w-full max-lg:border-e-0">
        <div className="space-y-2.5 border-b border-line p-3">
          <div className="relative">
            <Search size={14} className="absolute end-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.inbox.searchPlaceholder}
              aria-label={t.common.search}
              className="h-8 pe-9 text-[13px]"
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={() => setUnreadOnly((v) => !v)}
              aria-pressed={unreadOnly}
              className={cnRound(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                unreadOnly
                  ? "bg-brand-500 text-white"
                  : "text-ink-muted hover:bg-surface-3 hover:text-ink"
              )}
            >
              {t.inbox.unreadOnly}
              {unreadTotal > 0 && (
                <span className="num rounded-full bg-white/20 px-1.5 text-[10px] font-bold">{unreadTotal}</span>
              )}
            </button>
            <span className="num text-[10px] text-ink-subtle">{conversations.length}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto" role="listbox" aria-label={t.inbox.title}>
          {loading && <ConversationListSkeleton />}
          {listError && <p className="p-4 text-center text-xs text-red-600">{listError}</p>}
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
            <Button variant="ghost" size="sm" className="mx-auto my-2" onClick={() => fetchList({ append: true, cursor })}>
              {t.common.loadMore}
            </Button>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className="flex min-w-0 flex-1 flex-col bg-surface-1 max-lg:hidden">
        {!selected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-3 text-brand-500">
              <MessageSquareTextGlyph />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">{t.inbox.selectConversation}</p>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-ink-muted">{t.inbox.selectHint}</p>
            </div>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name={selected.customer.name ?? selected.customer.phone} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {selected.customer.name ?? selected.customer.phone ?? "عميل"}
                  </p>
                  <p className="text-[11px] text-ink-muted">
                    {CHANNEL_LABELS[selected.channel.type] ?? selected.channel.type} · {label(selected.customer.status)}
                    {selected.assignedAgent && ` · ${selected.assignedAgent.name}`}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {selected.aiState === "HUMAN_ACTIVE" ? (
                  <Button size="sm" variant="secondary" onClick={() => action("release-ai")}>
                    <Bot size={12} /> {t.inbox.backToAi}
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => action("takeover")}>
                    <Sparkles size={12} /> {t.inbox.takeOver}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => action("assign", { agentId: null })} disabled={!selected.assignedAgent}>
                  {t.common.unassign}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => action("assign", { agentId: "@me" })}>
                  {t.common.assignToMe}
                </Button>
                <Button size="sm" variant="success" onClick={resolve}>
                  <Check size={12} /> {t.inbox.resolve}
                </Button>
              </div>
            </header>

            <div className="flex-1 space-y-1.5 overflow-y-auto px-4 py-4">
              {messages.map((m, i) => {
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
              })}
              <div ref={bottomRef} />
            </div>

            <footer className="border-t border-line bg-surface-2 p-3">
              <div className="flex items-end gap-2">
                <div className="flex gap-1 pb-1">
                  <button
                    aria-label={t.inbox.attach}
                    title={t.inbox.attach + " (قريبًا)"}
                    disabled
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition hover:bg-surface-3 disabled:opacity-40"
                  >
                    <Paperclip size={15} />
                  </button>
                  <button
                    aria-label={t.inbox.emoji}
                    title={t.inbox.emoji + " (قريبًا)"}
                    disabled
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition hover:bg-surface-3 disabled:opacity-40"
                  >
                    <Smile size={15} />
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
                  className="max-h-32 min-h-[38px] flex-1 resize-none rounded-xl border border-line bg-surface-1 px-3.5 py-2 text-[13px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-brand-400 focus:ring-2 focus:ring-brand-100 dark:focus:ring-brand-500/20"
                />
                <Button onClick={() => void send()} disabled={sending || !draft.trim()} loading={sending} className="h-9 self-end">
                  {t.common.send}
                  <Send size={13} />
                </Button>
              </div>
              <p className="mt-1.5 text-[10px] text-ink-subtle">
                {selected.aiState === "HUMAN_ACTIVE" ? t.inbox.replyManually : t.inbox.replyWithAi}
              </p>
            </footer>
          </>
        )}
      </section>

      {/* Customer panel */}
      <aside className="hidden w-72 shrink-0 overflow-y-auto border-s border-line bg-surface-2 xl:block">
        <CustomerPanel customer={customer} orderDraft={orderDraftCard} />
      </aside>
    </div>
  );
}

function MessageSquareTextGlyph() {
  return <Search size={24} strokeWidth={1.6} aria-hidden />;
}

function cnRound(...parts: string[]) {
  return parts.join(" ");
}