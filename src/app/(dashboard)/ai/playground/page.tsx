"use client";

import { useEffect, useState } from "react";
import { FlaskConical, Play } from "lucide-react";
import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { CHANNEL_LABELS } from "@/components/inbox/types";

type ConversationOption = { id: string; customer: { name: string | null; phone: string | null }; channel: { type: string } };

type RunResult = {
  status: string;
  intent?: string;
  confidence?: number;
  plan?: Record<string, unknown>;
  response?: string;
  citations?: { sourceType: string; sourceId: string }[];
  violations?: string[];
  error?: string;
};

export default function AIPlaygroundPage() {
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [text, setText] = useState("بكم ماء الكمأة؟");
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/conversations?limit=20").then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setConversations(data.items);
        if (data.items[0]) setConversationId(data.items[0].id);
      }
    });
  }, []);

  async function run() {
    if (!conversationId || !text.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    const res = await fetch("/api/ai/playground", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, simulateText: text }),
    });
    setRunning(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل التشغيل");
      return;
    }
    setResult(await res.json());
  }

  return (
    <div className="page-wrap">
      <PageHeader title={t.pages.playgroundTitle} description={t.pages.playgroundDesc} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <GlassCard className="space-y-3.5 p-4 sm:p-5">
          <Field label="المحادثة">
            <Select value={conversationId} onChange={(e) => setConversationId(e.target.value)}>
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.customer.name ?? c.customer.phone} — {CHANNEL_LABELS[c.channel.type]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="رسالة العميل">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          </Field>
          <Button onClick={run} loading={running} disabled={running || !conversationId}>
            <Play size={14} />
            {running ? "جارٍ التشغيل…" : "تشغيل AI"}
          </Button>
          {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 ring-1 ring-inset ring-red-500/25 dark:text-red-400">{error}</p>}
        </GlassCard>

        <GlassCard className="p-4 sm:p-5">
          {!result ? (
            running ? (
              <div className="space-y-2.5">
                <Skeleton className="h-6 w-40 rounded-full" />
                <Skeleton className="h-24 rounded-xl" />
                <Skeleton className="h-10 w-2/3 rounded-xl" />
              </div>
            ) : (
              <EmptyState
                icon={<FlaskConical size={26} strokeWidth={1.5} />}
                title="النتيجة ستظهر هنا"
                description="النية، الكيانات، الخطة، الرد، والمصادر."
              />
            )
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge tone={result.status === "RESPONDED" ? "DELIVERED" : result.status === "HANDOFF" ? "CONFIRMATION_PENDING" : "NORMAL"} dot>
                  {result.status}
                </Badge>
                {result.intent && <Badge tone="AI_ACTIVE">{result.intent}</Badge>}
                {result.confidence !== undefined && <Badge>ثقة <span className="num">{Math.round(result.confidence * 100)}%</span></Badge>}
              </div>
              {result.plan && (
                <details open className="glass-subtle rounded-xl p-3">
                  <summary className="cursor-pointer text-xs font-bold text-ink-muted">خطة الرد</summary>
                  <pre className="num mt-2 overflow-x-auto rounded-lg bg-surface-3/70 p-2.5 text-[11px] leading-relaxed" dir="ltr">{JSON.stringify(result.plan, null, 2)}</pre>
                </details>
              )}
              {result.response && (
                <div>
                  <p className="mb-1.5 text-xs font-bold text-ink-muted">الرد النهائي</p>
                  <p className="whitespace-pre-wrap rounded-xl bg-violet-500/10 p-3.5 leading-relaxed text-violet-900 ring-1 ring-inset ring-violet-500/20 dark:text-violet-200">{result.response}</p>
                </div>
              )}
              {result.citations && result.citations.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-bold text-ink-muted">المصادر المستخدمة</p>
                  <div className="flex flex-wrap gap-1">
                    {result.citations.map((c, i) => (
                      <Badge key={i}>{c.sourceType}: <span className="num">{c.sourceId.slice(-6)}</span></Badge>
                    ))}
                  </div>
                </div>
              )}
              {result.violations && (
                <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-600 ring-1 ring-inset ring-red-500/25 dark:text-red-400">ملاحظات الحماية: {result.violations.join("، ")}</p>
              )}
              {result.error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-600 ring-1 ring-inset ring-red-500/25 dark:text-red-400">{result.error}</p>}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
