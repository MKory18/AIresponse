"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Eye, GitBranch, PauseCircle, PlayCircle, Plus, Power, Square, Trash2, Zap } from "lucide-react";
import { t, label as enumLabel } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { QuickRuleDialog } from "./quick-rule-dialog";
import { STEP_TYPES, WorkflowBuilderDialog } from "./workflow-builder-dialog";

/**
 * القواعد التلقائية — صفحة وحدة.
 *
 * ⚠️ قبل: «القواعد» و«سير العمل» صفحتين بيقروا **نفس الجدول** (`automation`):
 * كل قاعدة بتطلع بالقائمتين، والمسودة بتطلع بـ«القواعد» كـ«معطّلة» وزر «تفعيل»
 * كان بيشغّلها بلا نشر، وخطوات سير العمل كانت تطلع «—».
 * 🔧 قائمة وحدة بزرّين إنشاء: «قاعدة سريعة» (رسالة متابعة) و«قاعدة بخطوات».
 * كل صف بأزراره الصح حسب نوعه — والرابط القديم `/workflows` بيحوّل لهون.
 */

type Execution = { id: string; status: string; error: string | null; version?: number; stepIndex?: number; startedAt: string };

type Rule = {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  status: string;
  version: number;
  isEnabled: boolean;
  actions: unknown[];
  executions?: Execution[];
  _count?: { executions: number };
};

type PreviewStep = { stepId: string; type: string; outcome: string; reason?: string };

const STEP_LABEL: Record<string, string> = Object.fromEntries(STEP_TYPES.map((s) => [s.value, s.label]));

/**
 * قاعدة بخطوات = كل عنصر بـ`actions` شكله `{ id, action }`. القاعدة السريعة
 * (القديمة) عناصرها `{ type, … }` مباشرة — وإلها مفتاح تشغيل/إيقاف بس، لأن
 * «النشر» بيتحقق من شكل الخطوات وبيرفضها.
 */
function isStepRule(actions: unknown[]): boolean {
  return actions.length > 0 && actions.every((a) => !!a && typeof a === "object" && "action" in (a as object));
}

function stepTypes(rule: Rule): string[] {
  return rule.actions.map((a) => {
    const o = a as { type?: string; action?: { type?: string } };
    return o.action?.type ?? o.type ?? "";
  });
}

/** حالة القاعدة بكلمة وحدة بيفهمها صاحب المتجر. */
function ruleState(rule: Rule): { text: string; tone: string } {
  if (rule.status === "DRAFT") return { text: "مسودة — ما بتشتغل", tone: "NORMAL" };
  if (rule.isEnabled && rule.status === "PUBLISHED") return { text: "شغّالة", tone: "CONNECTED" };
  return { text: "موقوفة", tone: "PENDING" };
}

export default function AutomationPage() {
  const [items, setItems] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [create, setCreate] = useState<"quick" | "steps" | null>(null);
  const [detail, setDetail] = useState<(Rule & { executions: Execution[] }) | null>(null);
  const [preview, setPreview] = useState<{ conditionsMet: boolean; steps: PreviewStep[]; note?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows");
      if (!res.ok) throw new Error();
      setItems((await res.json()).items);
      setError(null);
    } catch {
      setError("تعذّر تحميل القواعد");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openDetail(id: string) {
    setBusy(`detail:${id}`);
    try {
      const res = await fetch(`/api/workflows/${id}`);
      if (!res.ok) throw new Error();
      setDetail(await res.json());
      setPreview(null);
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
    }
  }

  /** قاعدة سريعة: تشغيل/إيقاف بس. */
  async function toggleQuick(rule: Rule) {
    setBusy(`toggle:${rule.id}`);
    try {
      const res = await fetch(`/api/automations/${rule.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: rule.isEnabled ? "disable" : "enable" }),
      });
      if (!res.ok) throw new Error();
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
      load();
    }
  }

  /** قاعدة بخطوات: تشغيل (نشر) · إيقاف مؤقت · إيقاف وإلغاء الجاري. */
  async function lifecycle(rule: Rule, act: "publish" | "pause" | "stop") {
    setBusy(`${act}:${rule.id}`);
    try {
      const res = await fetch(`/api/workflows/${rule.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.show(data.message ?? "فشل تنفيذ الإجراء", "error");
      }
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
      load();
    }
  }

  async function previewRun(rule: Rule) {
    setBusy(`preview:${rule.id}`);
    try {
      const res = await fetch(`/api/workflows/${rule.id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sample: {} }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.show(data.message ?? "فشلت المحاكاة", "error");
        return;
      }
      setPreview(await res.json());
      setDetail(null);
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(`delete:${id}`);
    try {
      const res = await fetch(`/api/automations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setDeleteTarget(null);
    } catch {
      toast.show(t.inbox.actionFailed, "error");
    } finally {
      setBusy(null);
      load();
    }
  }

  const created = () => {
    setCreate(null);
    load();
  };

  return (
    <div className="page-wrap">
      <PageHeader
        title="القواعد التلقائية"
        description="لما يصير شي (طلب جديد، رسالة، تأكيد…) النظام بيعمل خطوة لحاله: يبعت رسالة، يجدول متابعة، يحط وسم أو يسند لموظف."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setCreate("quick")}>
              <Zap size={14} /> قاعدة سريعة
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCreate("steps")}>
              <GitBranch size={14} /> قاعدة بخطوات
            </Button>
          </div>
        }
      />

      {loading && (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      )}

      {!loading && error && (
        <GlassCard>
          <ErrorState onRetry={load} />
        </GlassCard>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-2.5">
          {items.map((rule) => {
            const steps = isStepRule(rule.actions);
            const state = ruleState(rule);
            const last = rule.executions?.[0];
            const running = rule.isEnabled && rule.status === "PUBLISHED";
            return (
              <GlassCard key={rule.id} className="p-4 transition-colors hover:border-brand-300/80 dark:hover:border-brand-700">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button type="button" className="flex min-w-0 items-start gap-2.5 text-start" onClick={() => openDetail(rule.id)} title="سجل التنفيذ">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${running ? "bg-primary-soft text-primary" : "bg-surface-3 text-ink-subtle"}`}>
                      {steps ? <GitBranch size={17} /> : <Zap size={17} />}
                    </span>
                    <span className="block min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
                        {rule.name}
                        <Badge tone={state.tone} dot>{state.text}</Badge>
                      </span>
                      <span className="mt-1 block text-xs text-ink-muted">
                        {enumLabel(rule.trigger)} ←{" "}
                        {stepTypes(rule).map((type) => STEP_LABEL[type] ?? enumLabel(type)).join(" ثم ")}
                        {rule._count?.executions ? <> · <span className="num">{rule._count.executions}</span> تنفيذ</> : null}
                        {last && <> · آخر مرة: {enumLabel(last.status)}</>}
                      </span>
                      {rule.description && <span className="mt-0.5 block text-xs text-ink-subtle">{rule.description}</span>}
                    </span>
                  </button>
                  <div className="flex flex-wrap gap-1.5">
                    {steps ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => previewRun(rule)} loading={busy === `preview:${rule.id}`}>
                          <Eye size={13} /> محاكاة
                        </Button>
                        {!running && (
                          <Button size="sm" variant="secondary" onClick={() => lifecycle(rule, "publish")} loading={busy === `publish:${rule.id}`}>
                            <PlayCircle size={13} /> تشغيل
                          </Button>
                        )}
                        {running && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => lifecycle(rule, "pause")} loading={busy === `pause:${rule.id}`}>
                              <PauseCircle size={13} /> إيقاف مؤقت
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => lifecycle(rule, "stop")} loading={busy === `stop:${rule.id}`} title="بيوقفها وبيلغي أي تنفيذ لسا شغّال">
                              <Square size={13} /> إيقاف وإلغاء الجاري
                            </Button>
                          </>
                        )}
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => toggleQuick(rule)} disabled={busy !== null} loading={busy === `toggle:${rule.id}`}>
                        <Power size={13} />
                        {rule.isEnabled ? "إيقاف" : "تشغيل"}
                      </Button>
                    )}
                    {!running && (
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(rule)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
                        <Trash2 size={13} /> {t.common.delete}
                      </Button>
                    )}
                  </div>
                </div>
              </GlassCard>
            );
          })}
          <p className="text-xs text-ink-muted">
            الرسائل المجدولة الي بتعملها القواعد بتلاقيها بـ{" "}
            <Link href="/follow-ups" className="font-bold text-primary hover:underline">المتابعات</Link>.
          </p>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<Zap size={28} strokeWidth={1.5} />}
            title="ولا قاعدة لسا"
            description="ابدأ بقاعدة سريعة: مثلًا رسالة «كيف كان طلبك؟» بعد ٢٤ ساعة من التأكيد."
            action={<Button size="sm" onClick={() => setCreate("quick")}><Plus size={14} /> قاعدة سريعة</Button>}
          />
        </GlassCard>
      )}

      <QuickRuleDialog open={create === "quick"} onClose={() => setCreate(null)} onCreated={created} />
      <WorkflowBuilderDialog open={create === "steps"} onClose={() => setCreate(null)} onCreated={created} />

      {/* سجل التنفيذ */}
      <Dialog open={!!detail} onClose={() => setDetail(null)} title={`سجل التنفيذ — ${detail?.name ?? ""}`}>
        <div className="space-y-2">
          {(detail?.executions ?? []).map((ex) => (
            <div key={ex.id} className="rounded-xl border border-line p-3">
              <p className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-ink">
                <Badge tone={ex.status}>{enumLabel(ex.status)}</Badge>
                {ex.stepIndex !== undefined && <span className="num text-ink-muted">خطوة {ex.stepIndex}</span>}
              </p>
              {ex.error && <p className="num mt-1 text-xs text-red-600 dark:text-red-400" dir="ltr">{ex.error}</p>}
              <p className="num mt-1 text-[11px] text-ink-subtle">{new Date(ex.startedAt).toLocaleString("ar")}</p>
            </div>
          ))}
          {(detail?.executions ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-ink-muted">ما اشتغلت ولا مرة لسا.</p>
          )}
        </div>
      </Dialog>

      {/* محاكاة */}
      <Dialog open={!!preview} onClose={() => setPreview(null)} title="محاكاة — بدون ما يتبعت أو يتغيّر شي">
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm">
            <PlayCircle size={16} className="text-brand-500" />
            الشروط متحققة: <b>{preview?.conditionsMet ? "نعم" : "لا"}</b>
          </p>
          {(preview?.steps ?? []).map((s, i) => (
            <div key={i} className="flex items-center justify-between rounded-xl border border-line px-3 py-2">
              <span className="text-xs text-ink-muted">{i + 1}. {STEP_LABEL[s.type] ?? enumLabel(s.type)}</span>
              <Badge tone={s.outcome === "WOULD_RUN" || s.outcome === "BRANCH_TAKEN" ? "CONNECTED" : s.outcome === "WOULD_WAIT" ? "PENDING" : "NORMAL"}>
                {enumLabel(s.outcome)}
              </Badge>
            </div>
          ))}
          {preview?.note && <p className="text-[11px] text-ink-subtle">{preview.note}</p>}
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void remove(deleteTarget.id)}
        title={`حذف القاعدة "${deleteTarget?.name ?? ""}"؟`}
        body="ما رح تشتغل بعد هيك. سجل التنفيذ السابق بيضل محفوظ."
        confirmLabel="حذف نهائي"
        busy={busy === `delete:${deleteTarget?.id}`}
        danger
      />
    </div>
  );
}
