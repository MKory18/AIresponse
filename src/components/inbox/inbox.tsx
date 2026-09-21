"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CHANNEL_ICONS,
  CHANNEL_LABELS,
  STATUS_STYLES,
  type ConversationListItem,
  type CustomerDetail,
  type MessageItem,
} from "./types";

type DraftInfo = {
  id: string;
  state: string;
  productName: string | null;
  quantity: number | null;
  phone: string | null;
  rawAddress: string | null;
  province: string | null;
  missingFields: string[];
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `${mins} د`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} س`;
  return `${Math.floor(hours / 24)} ي`;
}

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
        setListError("فشل تحميل المحادثات");
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

  // Initial + filter changes + polling
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      fetchList({ signal: controller.signal }).finally(() => setLoading(false));
    }, query ? 300 : 0);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchList]);

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
      setListError("فشل تنفيذ الإجراء");
    }
  }

  async function refreshSelected() {
    if (!selectedId) return;
    await Promise.all([fetchList(), refreshMessages(selectedId)]);
  }

  const btn =
    "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40";

  return (
    <div className="flex h-[calc(100vh-140px)] gap-4">
      {/* LEFT: conversation list */}
      <aside className="flex w-80 shrink-0 flex-col rounded-xl border border-slate-200 bg-white">
        <div className="space-y-2 border-b border-slate-100 p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="بحث بالاسم أو الهاتف أو نص الرسالة…"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            غير المقروءة فقط
          </label>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-sm text-slate-400">جارٍ التحميل…</p>}
          {listError && <p className="p-4 text-sm text-red-600">{listError}</p>}
          {!loading && conversations.length === 0 && !listError && (
            <p className="p-4 text-sm text-slate-400">لا توجد محادثات.</p>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`block w-full border-b border-slate-50 p-3 text-right transition hover:bg-slate-50 ${
                c.id === selectedId ? "bg-brand-50" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span title={CHANNEL_LABELS[c.channel.type]}>{CHANNEL_ICONS[c.channel.type]}</span>
                  <span className="truncate text-sm font-semibold text-slate-800">
                    {c.customer.name ?? c.customer.phone ?? "عميل"}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-slate-400">{timeAgo(c.lastCustomerMessageAt)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[c.status]}`}>
                  {c.status}
                </span>
                <span className="flex items-center gap-1 text-[10px] text-slate-500">
                  {c.aiState === "HUMAN_ACTIVE" ? (
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">موظف</span>
                  ) : (
                    <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700">AI</span>
                  )}
                  {c.priority !== "NORMAL" && (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{c.priority}</span>
                  )}
                  {c.assignedAgent && <span className="truncate">👤 {c.assignedAgent.name}</span>}
                  {c.unreadCount > 0 && (
                    <span className="rounded-full bg-brand-500 px-1.5 text-white">{c.unreadCount}</span>
                  )}
                </span>
              </div>
            </button>
          ))}
          {cursor && (
            <button
              onClick={() => fetchList({ append: true, cursor })}
              className="w-full p-3 text-xs text-brand-600 hover:underline"
            >
              تحميل المزيد…
            </button>
          )}
        </div>
      </aside>

      {/* CENTER: thread */}
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
            اختر محادثة لعرضها
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3">
              <div>
                <p className="text-sm font-bold text-slate-800">
                  {selected.customer.name ?? selected.customer.phone ?? "عميل"}
                </p>
                <p className="text-xs text-slate-500">
                  {CHANNEL_LABELS[selected.channel.type]} · {selected.customer.status}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {selected.aiState === "HUMAN_ACTIVE" ? (
                  <button className={btn} onClick={() => action("release-ai")}>
                    إعادة إلى AI
                  </button>
                ) : (
                  <button className={btn} onClick={() => action("takeover")}>
                    استلام من AI
                  </button>
                )}
                <button
                  className={btn}
                  onClick={() => action("assign", { agentId: null })}
                  disabled={!selected.assignedAgent}
                >
                  إلغاء التعيين
                </button>
                <button className={btn} onClick={() => action("assign", { agentId: "@me" })}>
                  تعيين لي
                </button>
                <button
                  className={btn}
                  onClick={() =>
                    fetch(`/api/conversations/${selected.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ status: "RESOLVED" }),
                    }).then(refreshSelected)
                  }
                >
                  تم الحل
                </button>
              </div>
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4">
              {messages.map((m) => {
                const outbound = m.direction === "OUTBOUND";
                return (
                  <div key={m.id} className={`flex ${outbound ? "justify-start" : "justify-end"}`}>
                    <div
                      className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm ${
                        outbound
                          ? "bg-brand-500 text-white"
                          : m.senderType === "SYSTEM"
                            ? "bg-slate-200 text-slate-600"
                            : "bg-white text-slate-800 shadow-sm"
                      }`}
                    >
                      {m.type !== "TEXT" && m.type !== "SYSTEM" && (
                        <p className="mb-1 text-[10px] opacity-70">[{m.type}]</p>
                      )}
                      {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
                      {m.mediaUrl && (
                        <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="underline">
                          مرفق ({m.type})
                        </a>
                      )}
                      <p className={`mt-1 text-[10px] ${outbound ? "text-white/70" : "text-slate-400"}`}>
                        {new Date(m.createdAt).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}
                        {outbound && m.senderType === "HUMAN" && ` · ${m.deliveryStatus}`}
                        {m.senderType === "AI" && " · AI"}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <footer className="flex items-center gap-2 border-t border-slate-100 p-3">
              <button className={btn} title="إرفاق (قريبًا)" disabled>
                📎
              </button>
              <button className={btn} title="رموز تعبيرية" disabled>
                😊
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="اكتب رسالة… (Enter للإرسال)"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
              <button
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-40"
              >
                إرسال
              </button>
            </footer>
          </>
        )}
      </section>

      {/* RIGHT: customer profile */}
      <aside className="hidden w-72 shrink-0 overflow-y-auto rounded-xl border border-slate-200 bg-white xl:block">
        {!customer ? (
          <p className="p-4 text-sm text-slate-400">لا يوجد عميل محدد.</p>
        ) : (
          <div className="space-y-4 p-4 text-sm">
            <div>
              <p className="text-base font-bold text-slate-800">{customer.name ?? "بدون اسم"}</p>
              <p className="mt-1 text-xs text-slate-500">{customer.phone ?? "بدون هاتف"}</p>
              {customer.province && <p className="text-xs text-slate-500">📍 {customer.province}</p>}
              {customer.address && <p className="text-xs text-slate-500">{customer.address}</p>}
            </div>
            {customer.identities.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-500">هويات القنوات</p>
                {customer.identities.map((i) => (
                  <p key={i.id} className="text-xs text-slate-600">
                    {CHANNEL_ICONS[i.channelType]} {CHANNEL_LABELS[i.channelType]}
                  </p>
                ))}
              </div>
            )}
            {customer.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {customer.tags.map((t) => (
                  <span key={t} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">آخر الطلبات</p>
              {customer.orders.length === 0 && <p className="text-xs text-slate-400">لا يوجد طلبات.</p>}
              {customer.orders.map((o) => (
                <p key={o.id} className="flex justify-between text-xs text-slate-600">
                  <span>{o.orderNumber}</span>
                  <span>{o.status}</span>
                </p>
              ))}
            </div>
            {orderDraftCard && (
              <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-2">
                <p className="mb-1 text-xs font-semibold text-brand-700">
                  مسودة طلب · {orderDraftCard.state}
                </p>
                {orderDraftCard.productName && <p className="text-xs text-slate-600">المنتج: {orderDraftCard.productName}</p>}
                {orderDraftCard.quantity && <p className="text-xs text-slate-600">الكمية: {orderDraftCard.quantity}</p>}
                <p className="text-xs text-slate-600">الهاتف: {orderDraftCard.phone ? "✓" : "✗"}</p>
                <p className="text-xs text-slate-600">العنوان: {orderDraftCard.rawAddress || orderDraftCard.province ? "✓" : "✗"}</p>
                {orderDraftCard.missingFields.length > 0 ? (
                  <p className="mt-1 text-[10px] text-amber-700">ينقص: {orderDraftCard.missingFields.join("، ")}</p>
                ) : (
                  <p className="mt-1 text-[10px] text-emerald-700">جاهز للتأكيد ✓</p>
                )}
              </div>
            )}
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">ملخص AI</p>
              <p className="rounded-lg bg-violet-50 p-2 text-xs text-violet-700">
                {customer.aiSummary ?? "لم يتم توليد ملخص بعد (يُفعّل في مرحلة AI Engine)."}
              </p>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
