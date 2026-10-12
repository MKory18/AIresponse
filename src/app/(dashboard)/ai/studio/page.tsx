"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FlaskConical, PlugZap, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard, PageHeader } from "@/components/ui/card";

type ProviderInfo = { id: string; configured: boolean; status: string; endpoint: string | null };
type TaskInfo = { task: string; model: string; temperature: number; maxTokens: number; defaultModel: string; compatible: boolean; compatibilityReason: string };
type StatusData = {
  provider: string;
  aiEnabled: boolean;
  autoRespond: boolean;
  effectiveProvider: { name: string; delivery: string; status: string } | null;
  providers: ProviderInfo[];
  tasks: TaskInfo[];
  embedding: { provider: string; model: string; dimensions: number };
  fallback: { provider: string | null; model: string | null; configured: boolean };
  knowledge: { ready: number; processing: number; failed: number; faqs: number; personas: number };
};

type TestResult = { provider: string; status: string; latencyMs: number; detail: string; endpoint?: string; model?: string; chat?: { ok: boolean; latencyMs: number; detail: string; model: string }; embeddings?: { ok: boolean; latencyMs: number; detail: string; model: string; dimensions: number | null } };

const STATUS_TONE: Record<string, string> = {
  working: "DELIVERED",
  configured: "CONFIRMATION_PENDING",
  local: "DELIVERED",
  needs_key: "FAILED",
  failed: "FAILED",
  unconfigured: "CLOSED",
  disabled: "CLOSED",
};

const STATUS_AR: Record<string, string> = {
  working: "يعمل",
  configured: "مهيأ",
  local: "يعمل محليًا",
  needs_key: "يحتاج مفتاح",
  failed: "فشل الاتصال",
  unconfigured: "غير مهيأ",
  disabled: "متوقف",
};

const TASK_AR: Record<string, string> = {
  CLASSIFICATION: "فهم النية",
  EXTRACTION: "استخراج البيانات",
  RESPONSE: "توليد الرد",
  VISION: "الرؤية",
  SUMMARY: "تلخيص المحادثة",
  EMBEDDING: "التضمينات",
  RETRIEVAL: "الاسترجاع",
};

// Display names for provider ids — the internal "hermes" value never shows.
const PROVIDER_AR: Record<string, string> = {
  mock: "وهمي (تجريبي)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  internal: "داخلي",
  hermes: "الوكيل الذكي",
};
const providerLabel = (id: string | null | undefined) => (id ? PROVIDER_AR[id] ?? id : "—");

export default function AIStudioPage() {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/ai/status");
    if (!res.ok) {
      setError("فشل تحميل حالة الاستوديو");
      return;
    }
    setData(await res.json());
    setError(null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function testProvider(id: string) {
    setTesting(id);
    try {
      const res = await fetch("/api/ai/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: id }),
      });
      if (res.ok) {
        const r = (await res.json()) as TestResult;
        setResults((prev) => ({ ...prev, [id]: r }));
      } else {
        // فشل صريح — لا اختفاء للاختبار بلا نتيجة
        setResults((prev) => ({ ...prev, [id]: { provider: id, status: "failed", latencyMs: 0, detail: `فشل الاختبار (${res.status})` } }));
      }
    } catch {
      setResults((prev) => ({ ...prev, [id]: { provider: id, status: "failed", latencyMs: 0, detail: "تعذر الاتصال بالخادم" } }));
    } finally {
      setTesting(null);
    }
  }

  if (!data) {
    return (
      <div className="page-wrap">
        <PageHeader title="استوديو الذكاء الاصطناعي" description="المزودون والنماذج والشخصيات والمعرفة والاختبار من مكان واحد" />
        {error ? <p className="text-sm text-red-600">{error}</p> : <div className="space-y-3"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-40 rounded-2xl" /></div>}
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title="استوديو الذكاء الاصطناعي"
        description="المزودون والنماذج والشخصيات والمعرفة والاختبار من مكان واحد"
        actions={
          <Button size="sm" variant="ghost" onClick={load}>
            <RefreshCw size={14} /> تحديث
          </Button>
        }
      />

      {!data.aiEnabled && (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-inset ring-red-500/25">
          الذكاء متوقف على مستوى المؤسسة (aiEnabled = false) — كل الطلبات تسجل AI_DISABLED ولا يخرج أي استدعاء خارجي.
        </p>
      )}

      <GlassCard className="p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600"><PlugZap size={15} /></span>
          المزود الفعّال والمزودون
        </h2>
        <p className="mt-2 text-xs text-ink-muted">
          الفعّال: <strong>{providerLabel(data.effectiveProvider?.name)}</strong> ({data.effectiveProvider?.delivery ?? "—"}) — الحالة: <strong>{STATUS_AR[data.effectiveProvider?.status ?? ""] ?? data.effectiveProvider?.status ?? "—"}</strong>
          {" "}· الاختيار المهيأ: {providerLabel(data.provider)} {data.fallback.configured ? `· البديل: ${data.fallback.model} (عند الفشل فقط)` : "· بلا بديل مهيأ"}
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.providers.map((p) => {
            const r = results[p.id];
            const shown = r?.status ?? p.status;
            return (
              <div key={p.id} className="rounded-xl border border-line bg-surface-2/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm text-ink">{providerLabel(p.id)}</strong>
                  <Badge tone={STATUS_TONE[shown] ?? "CLOSED"} dot>
                    {STATUS_AR[shown] ?? shown}
                    {r?.status !== shown && <span className="ms-1 font-normal text-[10px]">(حالة محفوظة — لم يُختبر حيًا)</span>}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-[11px] text-ink-muted" dir="ltr">{p.endpoint ?? "—"}</p>
                {r && <p className="mt-1 text-[11px] text-ink-muted" dir="ltr">{r.detail} · {r.latencyMs}ms{r.model ? ` · ${r.model}` : ""}</p>}
                {r?.embeddings && (
                  <p className="mt-1 text-[11px] text-ink-muted" dir="ltr">
                    embeddings: {r.embeddings.detail} · {r.embeddings.latencyMs}ms · {r.embeddings.model}
                    {typeof r.embeddings.dimensions === "number" ? ` · ${r.embeddings.dimensions}d` : ""}
                  </p>
                )}
                <div className="mt-2">
                  <Button size="sm" variant="ghost" loading={testing === p.id} disabled={testing === p.id} onClick={() => testProvider(p.id)}>
                    اختبار الاتصال
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-ink-muted">اختبار الاتصال يرسل ping اصطناعيًا فقط (بلا بيانات عملاء) ولا يعرض المفاتيح أبدًا.</p>
      </GlassCard>

      <GlassCard className="p-4 sm:p-5">
        <h2 className="text-sm font-bold text-ink">نماذج المهام</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-ink-muted"><th className="p-2 text-start">المهمة</th><th className="p-2 text-start">النموذج</th><th className="p-2 text-start">التوافق</th></tr></thead>
            <tbody>
              {data.tasks.map((t) => (
                <tr key={t.task} className="border-t border-line">
                  <td className="p-2 font-medium text-ink">{TASK_AR[t.task] ?? t.task}</td>
                  <td className="p-2 text-ink-muted" dir="ltr">{t.model}{t.model !== t.defaultModel ? "" : " (افتراضي)"}</td>
                  <td className="p-2"><Badge tone={t.compatible ? "DELIVERED" : "FAILED"} dot>{t.compatible ? "متوافق" : t.compatibilityReason}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/settings/ai"><Button size="sm" variant="ghost">إعدادات النماذج</Button></Link>
        </div>
      </GlassCard>

      <GlassCard className="p-4 sm:p-5">
        <h2 className="text-sm font-bold text-ink">الشخصيات والتعليمات والمعرفة</h2>
        <p className="mt-2 text-xs text-ink-muted">
          شخصيات: {data.knowledge.personas} · مستندات جاهزة: {data.knowledge.ready} · قيد الفهرسة: {data.knowledge.processing} · فاشلة: {data.knowledge.failed} · أسئلة شائعة: {data.knowledge.faqs}
          {" "}· التضمينات: <span dir="ltr">{data.embedding.provider}/{data.embedding.model}/{data.embedding.dimensions}</span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/personas"><Button size="sm" variant="ghost">الشخصيات والإصدارات</Button></Link>
          <Link href="/knowledge"><Button size="sm" variant="ghost">مصادر المعرفة</Button></Link>
          <Link href="/ai/playground"><Button size="sm" variant="ghost"><FlaskConical size={14} /> Playground معزول</Button></Link>
          <Link href="/analytics/ai"><Button size="sm" variant="ghost">الاستخدام والتكلفة</Button></Link>
        </div>
      </GlassCard>
    </div>
  );
}
