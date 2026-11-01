"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, FlaskConical, Plus, RotateCcw, Send, Trash2, User } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type Session = {
  id: string;
  personaId: string | null;
  channelId: string | null;
  productId: string | null;
  useKnowledge: boolean;
  model: string | null;
  updatedAt: string;
};

type ChatMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  metadata?: {
    provider?: string;
    model?: string;
    persona?: { name: string; source: string };
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    sources?: { kind: string; id: string; title: string; score?: number; preview?: string }[];
    violations?: string[];
    orderProposal?: {
      intent: string;
      confidence: number;
      entities: Record<string, unknown>;
      missingFields: string[];
      requestedAction: string;
    } | null;
  };
};

type PersonaOption = { id: string; name: string };
type ChannelOption = { channelId: string; pageId: string | null; pageName: string | null; status: string };
type ProductOption = { id: string; name: string };

export default function AIPlaygroundPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [personaId, setPersonaId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [model, setModel] = useState("");
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [productId, setProductId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [task, setTask] = useState("RESPONSE");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [withOrderProposal, setWithOrderProposal] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedText, setFailedText] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadOptions = useCallback(async () => {
    const [pRes, cRes, prRes, sRes] = await Promise.all([
      fetch("/api/personas"),
      fetch("/api/channels/facebook"),
      fetch("/api/products?limit=100"),
      fetch("/api/ai/playground/sessions"),
    ]);
    if (pRes.ok) {
      const list: PersonaOption[] = (await pRes.json()).items ?? [];
      setPersonas(list);
      // جاي من «جرّبها» بصفحة الشخصيات (`?persona=`) — بنختارها جاهزة.
      try {
        const fromUrl = new URLSearchParams(window.location.search).get("persona");
        if (fromUrl && list.some((p) => p.id === fromUrl)) setPersonaId(fromUrl);
      } catch { /* ignore */ }
    }
    if (cRes.ok) setChannels((await cRes.json()).connections ?? []);
    if (prRes.ok) setProducts((await prRes.json()).items ?? []);
    if (sRes.ok) setSessions((await sRes.json()).items ?? []);
  }, []);

  const loadSession = useCallback(async (id: string) => {
    const res = await fetch(`/api/ai/playground/sessions/${id}`);
    if (res.ok) {
      const data = await res.json();
      sessionIdRef.current = data.session.id;
      setSessionId(data.session.id);
      setMessages(data.messages);
      setConfigDirty(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }, []);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  function markDirty() {
    if (messages.length > 0) setConfigDirty(true);
  }

  async function newChat() {
    setError(null);
    const res = await fetch("/api/ai/playground/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personaId: personaId || null,
        channelId: channelId || null,
        productId: productId || null,
        useKnowledge,
        model: model.trim() || null,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل الإنشاء");
      return;
    }
    const session = await res.json();
    sessionIdRef.current = session.id;
    setSessionId(session.id);
    setMessages([]);
    setConfigDirty(false);
    const sRes = await fetch("/api/ai/playground/sessions");
    if (sRes.ok) setSessions((await sRes.json()).items ?? []);
  }

  async function clearChat() {
    if (!sessionId) {
      await newChat();
      return;
    }
    await fetch(`/api/ai/playground/sessions/${sessionId}`, { method: "DELETE" });
    sessionIdRef.current = null;
    setSessionId(null);
    setMessages([]);
    await newChat();
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? draft).trim();
    if (!text || sending) return;
    let sid = sessionId;
    if (!sid) {
      // جلسة واحدة فقط: استخدم نتيجة newChat بدل إنشاء جلسة ثانية بالتوازي
      await newChat();
      sid = sessionIdRef.current;
      if (!sid) {
        setError("فشل إنشاء جلسة — حاول مجددًا");
        return;
      }
    }
    if (!sid) {
      setSending(false);
      return;
    }
    setDraft("");
    setError(null);
    setFailedText(null);
    setSending(true);
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      const res = await fetch(`/api/ai/playground/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          withOrderProposal,
          customerName: customerName.trim() || undefined,
          task: task === "RESPONSE" ? undefined : task,
          draftInstructions: draftInstructions.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "");
      await loadSession(sid);
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      setFailedText(text);
      setError(t.playground.aiFailed);
    } finally {
      setSending(false);
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const personaName = lastAssistant?.metadata?.persona?.name;

  return (
    <div className="page-wrap">
      <PageHeader title={t.playground.title} description={t.playground.subtitle} />
      <p className="rounded-2xl bg-amber-500/10 px-4 py-2.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300">
        {t.playground.isolatedNote}
      </p>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        {/* Config + sessions */}
        <div className="space-y-4">
          <GlassCard className="space-y-3 p-4">
            <Field label={t.playground.persona}>
              <Select value={personaId} onChange={(e) => { setPersonaId(e.target.value); markDirty(); }}>
                <option value="">الافتراضية (حسب الصفحة)</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={t.playground.page}>
              <Select value={channelId} onChange={(e) => { setChannelId(e.target.value); markDirty(); }}>
                <option value="">{t.playground.noPage}</option>
                {channels.map((c) => (
                  <option key={c.channelId} value={c.channelId}>{c.pageName ?? c.pageId} · {c.status}</option>
                ))}
              </Select>
            </Field>
            <Field label={t.playground.model}>
              <Input value={model} onChange={(e) => { setModel(e.target.value); markDirty(); }} placeholder={t.playground.defaultModel} dir="ltr" className="num" />
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-ink">
              <input type="checkbox" checked={useKnowledge} onChange={(e) => { setUseKnowledge(e.target.checked); markDirty(); }} className="h-4 w-4 accent-brand-500" />
              {t.playground.useKnowledge}
            </label>
            <Field label={t.playground.selectProduct}>
              <Select value={productId} onChange={(e) => { setProductId(e.target.value); markDirty(); }}>
                <option value="">{t.playground.noProduct}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={t.playground.customerContext}>
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="اسم تجريبي (اختياري)" />
            </Field>
            <Field label="المهمة (نموذجها الخاص)">
              <Select value={task} onChange={(e) => { setTask(e.target.value); markDirty(); }}>
                <option value="RESPONSE">توليد الرد</option>
                <option value="EXTRACTION">استخراج البيانات</option>
                <option value="SUMMARY">تلخيص المحادثة</option>
              </Select>
            </Field>
            <Field label="تعليمات مسودة للاختبار (لا تُنشر)">
              <Input value={draftInstructions} onChange={(e) => setDraftInstructions(e.target.value)} placeholder="اختياري — تُستخدم في هذه الجلسة فقط" />
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-ink">
              <input type="checkbox" checked={withOrderProposal} onChange={(e) => setWithOrderProposal(e.target.checked)} className="h-4 w-4 accent-brand-500" />
              {t.playground.testOrder}
            </label>
            {configDirty && (
              <Button size="sm" variant="secondary" className="w-full" onClick={newChat}>
                بدء محادثة بالإعدادات الجديدة
              </Button>
            )}
          </GlassCard>

          <GlassCard className="space-y-2 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-ink-muted">الجلسات</p>
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={newChat}>
                  <Plus size={13} />
                  {t.playground.newChat}
                </Button>
                <Button size="sm" variant="ghost" onClick={clearChat} disabled={!sessionId}>
                  <Trash2 size={13} />
                  {t.playground.clearChat}
                </Button>
              </div>
            </div>
            {sessions.length === 0 && <p className="text-xs text-ink-subtle">{t.playground.noSessions}</p>}
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {sessions.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => loadSession(s.id)}
                  className={cn(
                    "block w-full truncate rounded-xl px-2.5 py-1.5 text-start text-xs font-semibold transition",
                    s.id === sessionId ? "bg-brand-500/10 text-brand-700 dark:text-brand-300" : "text-ink-muted hover:bg-surface-3"
                  )}
                >
                  جلسة <span className="num">{sessions.length - i}</span> · <span className="num">{new Date(s.updatedAt).toLocaleDateString("ar")}</span>
                </button>
              ))}
            </div>
          </GlassCard>
        </div>

        {/* Chat */}
        <GlassCard className="flex min-h-[60vh] flex-col overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-4 py-2.5">
            <p className="flex items-center gap-2 text-sm font-bold text-ink">
              <FlaskConical size={15} className="text-brand-500" />
              {t.playground.testReply}
            </p>
            {personaName && (
              <p className="text-[11px] text-ink-muted">
                {t.playground.personaUsed}: <span className="font-bold text-ink">{personaName}</span>
              </p>
            )}
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-4 sm:px-5">
            {messages.length === 0 && !sending && (
              <EmptyState
                icon={<Bot size={26} strokeWidth={1.5} />}
                title={t.playground.title}
                description={t.playground.subtitle}
              />
            )}
            {messages.map((m) => (
              <div key={m.id}>
                <div className={cn("flex w-full", m.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed", m.role === "user" ? "bubble-in" : "bubble-out")}>
                    <p className="mb-1 flex items-center gap-1 text-[10px] font-bold opacity-70">
                      {m.role === "user" ? <User size={11} /> : <Bot size={11} />}
                      {m.role === "user" ? "أنت" : (m.metadata?.persona?.name ?? "المساعد")}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  </div>
                </div>
                {m.role === "assistant" && m.metadata?.sources && m.metadata.sources.length > 0 && (
                  <div className="mt-1.5 ms-1">
                    <p className="mb-1 text-[10px] font-bold text-ink-muted">{t.playground.sourcesUsed}</p>
                    <div className="flex flex-wrap gap-1">
                      {m.metadata.sources.map((s, i) => (
                        <Badge key={i} title={s.preview ?? s.title}>
                          {s.title} {s.score !== undefined && <span className="num">· {s.score.toFixed(2)}</span>}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {m.role === "assistant" && m.metadata?.orderProposal && (
                  <div className="glass-subtle mt-1.5 ms-1 rounded-xl p-2.5 text-[11px]">
                    <p className="mb-1 font-bold text-ink">{t.playground.orderProposal}</p>
                    <pre className="num overflow-x-auto text-[10px] leading-relaxed" dir="ltr">
                      {JSON.stringify(m.metadata.orderProposal, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div className="space-y-2">
                <Skeleton className="h-16 w-2/3 rounded-2xl" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {error && (
            <div className="mx-3 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-600 ring-1 ring-inset ring-red-500/25 dark:text-red-400 sm:mx-5">
              <span>{error === t.playground.aiFailed && failedText ? error : error}</span>
              {failedText && (
                <button onClick={() => send(failedText)} className="inline-flex items-center gap-1 font-bold underline underline-offset-2">
                  <RotateCcw size={11} />
                  {t.delivery.retry}
                </button>
              )}
            </div>
          )}

          {lastAssistant && (
            <div className="border-t border-line/60 px-3 py-2 sm:px-5">
              <button onClick={() => setShowDebug((v) => !v)} className="text-[11px] font-bold text-brand-600 hover:underline dark:text-brand-300">
                {showDebug ? t.playground.hideDebug : t.playground.showDebug}
              </button>
              {showDebug && lastAssistant.metadata && (
                <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-ink-muted sm:grid-cols-3">
                  <div><dt className="font-bold">{t.playground.provider}</dt><dd>{lastAssistant.metadata.provider ?? "—"}</dd></div>
                  <div><dt className="font-bold">{t.playground.model}</dt><dd dir="ltr">{lastAssistant.metadata.model ?? "—"}</dd></div>
                  <div><dt className="font-bold">{t.playground.persona}</dt><dd>{lastAssistant.metadata.persona?.name ?? "—"}</dd></div>
                  <div><dt className="font-bold">{t.playground.responseTime}</dt><dd>{lastAssistant.metadata.latencyMs ?? 0}ms</dd></div>
                  <div><dt className="font-bold">{t.playground.tokens}</dt><dd>{lastAssistant.metadata.promptTokens ?? 0}+{lastAssistant.metadata.completionTokens ?? 0}</dd></div>
                  <div><dt className="font-bold">{t.playground.knowledgeUsed}</dt><dd>{useKnowledge ? "نعم" : "لا"}</dd></div>
                </dl>
              )}
            </div>
          )}

          <div className="border-t border-line bg-surface-2 p-3">            <div className="glass-subtle flex items-end gap-1.5 rounded-2xl p-1.5">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder={t.playground.composerPlaceholder}
                aria-label={t.playground.composerPlaceholder}
                className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-subtle"
              />
              <Button onClick={() => send()} disabled={sending || !draft.trim()} loading={sending} size="icon" aria-label={t.playground.send} className="h-10 w-10 shrink-0 rounded-xl">
                {!sending && <Send size={16} className="-scale-x-100" />}
              </Button>
            </div>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
