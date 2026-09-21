"use client";

import { useEffect, useState } from "react";
import { CHANNEL_LABELS } from "@/components/inbox/types";

type ConversationOption = { id: string; customer: { name: string | null; phone: string | null }; channel: { type: string } };

const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500";

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
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">ملعب اختبار AI</h1>
        <p className="mt-1 text-xs text-slate-500">
          يشغّل خط المعالجة كاملاً في وضع Dry-run — لا يُرسل أي شيء إلى فيسبوك ميسنجر.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <label className="block text-xs text-slate-500">
            المحادثة
            <select value={conversationId} onChange={(e) => setConversationId(e.target.value)} className={input}>
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.customer.name ?? c.customer.phone} — {CHANNEL_LABELS[c.channel.type]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-slate-500">
            رسالة العميل
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={input} />
          </label>
          <button
            onClick={run}
            disabled={running || !conversationId}
            className="rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {running ? "جارٍ التشغيل…" : "تشغيل AI"}
          </button>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        </div>

        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          {!result ? (
            <p className="text-sm text-slate-400">النتيجة ستظهر هنا: النية، الكيانات، الخطة، الرد، والمصادر.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className={`rounded px-2 py-0.5 ${result.status === "RESPONDED" ? "bg-emerald-50 text-emerald-700" : result.status === "HANDOFF" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                  {result.status}
                </span>
                {result.intent && <span className="rounded bg-violet-50 px-2 py-0.5 text-violet-700">{result.intent}</span>}
                {result.confidence !== undefined && <span className="rounded bg-slate-100 px-2 py-0.5">ثقة {Math.round(result.confidence * 100)}%</span>}
              </div>
              {result.plan && (
                <details open>
                  <summary className="cursor-pointer text-xs font-semibold text-slate-500">خطة الرد</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px]" dir="ltr">{JSON.stringify(result.plan, null, 2)}</pre>
                </details>
              )}
              {result.response && (
                <div>
                  <p className="text-xs font-semibold text-slate-500">الرد النهائي</p>
                  <p className="whitespace-pre-wrap rounded-lg bg-violet-50 p-3 text-violet-900">{result.response}</p>
                </div>
              )}
              {result.citations && result.citations.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500">المصادر المستخدمة</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {result.citations.map((c, i) => (
                      <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                        {c.sourceType}: {c.sourceId.slice(-6)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {result.violations && (
                <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-600">ملاحظات الحماية: {result.violations.join(", ")}</p>
              )}
              {result.error && <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-600">{result.error}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
