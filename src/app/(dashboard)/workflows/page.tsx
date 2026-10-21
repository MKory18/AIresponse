"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, PlayCircle, Plus, Send, Trash2, Upload, Eye, Square, PauseCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, ErrorState } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard, PageHeader } from "@/components/ui/card";
import { label as enumLabel } from "@/lib/i18n";

type Condition = { field: string; operator: string; value?: string | number | boolean | null };

type StepForm = {
  type: string;
  template?: string;
  text?: string;
  tag?: string;
  agentId?: string;
  minutes?: number;
  delayHours?: number;
  followUpType?: string;
  aiState?: string;
  instructions?: string;
};

type Step = { id: string; action: StepForm };

type Workflow = {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  status: string;
  version: number;
  isEnabled: boolean;
  priority: number;
  actions: Step[];
  conditions: { all?: Condition[]; any?: Condition[] };
  executions?: { id: string; status: string; error: string | null; errorCategory: string | null; version: number; stepIndex: number; startedAt: string; completedAt: string | null }[];
  _count?: { executions: number };
};

type PreviewStep = { stepId: string; type: string; outcome: string; reason?: string };

const TRIGGERS = [
  "MESSAGE_RECEIVED", "CONVERSATION_CREATED", "CONVERSATION_STATUS_CHANGED",
  "CONVERSATION_ASSIGNED", "HANDOFF_CREATED", "CUSTOMER_TAGGED", "CUSTOMER_CREATED",
  "ORDER_CREATED", "ORDER_CONFIRMED", "ORDER_CANCELLED",
] as const;

const CONDITION_FIELDS = [
  "conversation.status", "conversation.aiState", "conversation.channelType",
  "customer.tags", "customer.isBlacklisted", "customer.leadScore",
  "order.status", "order.total", "event.minutesSinceLastCustomerMessage",
] as const;

const OPERATORS = ["EQ", "NEQ", "GT", "GTE", "LT", "LTE", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "EXISTS", "NOT_EXISTS"];

const STEP_TYPES = [
  { value: "SEND_MESSAGE", label: "إرسال رسالة" },
  { value: "CREATE_NOTE", label: "ملاحظة داخلية" },
  { value: "CREATE_FOLLOW_UP", label: "إنشاء متابعة" },
  { value: "CANCEL_FOLLOW_UPS", label: "إلغاء المتابعات" },
  { value: "ADD_TAG", label: "إضافة وسم" },
  { value: "REMOVE_TAG", label: "إزالة وسم" },
  { value: "ASSIGN_CONVERSATION", label: "إسناد المحادثة" },
  { value: "CHANGE_AI_STATE", label: "تغيير حالة الذكاء" },
  { value: "WAIT", label: "انتظار (دقائق)" },
  { value: "STOP_WORKFLOW", label: "إيقاف سير العمل" },
] as const;

const STATUS_TONE: Record<string, string> = {
  DRAFT: "NORMAL", PUBLISHED: "CONNECTED", PAUSED: "PENDING",
};

function stepToAction(s: StepForm): Record<string, unknown> {
  const a: Record<string, unknown> = { type: s.type };
  if (s.template !== undefined) a.template = s.template;
  if (s.text !== undefined) a.text = s.text;
  if (s.tag !== undefined) a.tag = s.tag;
  if (s.agentId !== undefined) a.agentId = s.agentId;
  if (s.minutes !== undefined) a.minutes = Number(s.minutes);
  if (s.delayHours !== undefined) a.delayHours = Number(s.delayHours);
  if (s.followUpType) a.followUpType = s.followUpType;
  if (s.aiState) a.aiState = s.aiState;
  if (s.instructions !== undefined) a.instructions = s.instructions;
  return a;
}

const EMPTY_STEP: StepForm = { type: "SEND_MESSAGE", template: "" };

export default function WorkflowsPage() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState<string>("MESSAGE_RECEIVED");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [steps, setSteps] = useState<StepForm[]>([{ ...EMPTY_STEP }]);
  const [detail, setDetail] = useState<Workflow | null>(null);
  const [preview, setPreview] = useState<{ mode: string; conditionsMet: boolean; steps: PreviewStep[]; note?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows");
      if (!res.ok) throw new Error();
      setItems((await res.json()).items);
      setError(null);
    } catch {
      setError("تعذّر تحميل سير العمل");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canSubmit = useMemo(() => name.trim().length >= 2 && steps.length > 0, [name, steps.length]);

  async function openDetail(id: string) {
    setBusy(`detail:${id}`);
    const res = await fetch(`/api/workflows/${id}`);
    setBusy(null);
    if (res.ok) {
      const data = await res.json();
      setDetail(data);
      setPreview(null);
    }
  }

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    const res = await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: description || undefined,
        definition: {
          trigger,
          conditions: conditions.length ? { all: conditions } : undefined,
          steps: steps.map((s, i) => ({ id: `s${i + 1}`, action: stepToAction(s) })),
        },
        priority: 0,
      }),
    });
    setCreating(false);
    if (res.ok) {
      setShowForm(false);
      setName("");
      setDescription("");
      setConditions([]);
      setSteps([{ ...EMPTY_STEP }]);
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل إنشاء سير العمل");
    }
  }

  async function action(wf: Workflow, act: string) {
    setBusy(`${act}:${wf.id}`);
    setError(null);
    const res = await fetch(`/api/workflows/${wf.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: act }),
    });
    setBusy(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل تنفيذ الإجراء");
    }
    load();
    if (detail?.id === wf.id) openDetail(wf.id);
  }

  async function previewRun(wf: Workflow) {
    setBusy(`preview:${wf.id}`);
    setError(null);
    const res = await fetch(`/api/workflows/${wf.id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample: {} }),
    });
    setBusy(null);
    if (res.ok) {
      setPreview(await res.json());
      setDetail(null);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "فشل المحاكاة");
    }
  }

  async function remove(id: string) {
    setBusy(`delete:${id}`);
    try {
      const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? "فشل الحذف");
      }
    } catch {
      setError("فشل الحذف");
    } finally {
      setBusy(null);
      setDeleteTarget(null);
      load();
    }
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title="محرك سير العمل"
        description="سير عمل متعدد الخطوات مع شروط وتأخيرات وتنفيذ مرة واحدة بالضبط — الرسائل تُعاد فلترتها لحظة الإرسال."
        actions={
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus size={14} /> سير عمل جديد
          </Button>
        }
      />
      {error && (
        <GlassCard level="glass-subtle" className="border-red-500/20 px-4 py-2.5 text-sm text-red-600 dark:text-red-400">{error}</GlassCard>
      )}

      {loading && (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      )}

      {!loading && error && items.length === 0 && (
        <GlassCard>
          <ErrorState onRetry={load} />
        </GlassCard>
      )}

      {!loading && (
        <div className="space-y-2.5">
          {items.map((wf) => (
            <GlassCard key={wf.id} className="p-4 transition-colors hover:border-brand-300/80 dark:hover:border-brand-700">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button type="button" className="flex min-w-0 items-start gap-2.5 text-start" onClick={() => openDetail(wf.id)}>
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${wf.isEnabled ? "bg-primary-soft text-primary" : "bg-surface-3 text-ink-subtle"}`}>
                    <GitBranch size={17} />
                  </span>
                  <span className="block min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
                      {wf.name}
                      <Badge tone={STATUS_TONE[wf.status] ?? "NORMAL"}>{enumLabel(wf.status)}</Badge>
                      <Badge tone="NORMAL">v{wf.version}</Badge>
                    </span>
                    <span className="num mt-1 block text-xs text-ink-muted">
                      {enumLabel(wf.trigger)} · {wf.actions?.length ?? 0} خطوة · {wf._count?.executions ?? 0} تنفيذ
                      {wf.executions?.[0] && <> · آخر حالة: {enumLabel(wf.executions[0].status)}</>}
                    </span>
                  </span>
                </button>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => previewRun(wf)} loading={busy === `preview:${wf.id}`}>
                    <Eye size={13} /> محاكاة
                  </Button>
                  {wf.status === "DRAFT" && (
                    <Button size="sm" variant="secondary" onClick={() => action(wf, "publish")} loading={busy === `publish:${wf.id}`}>
                      <Upload size={13} /> نشر
                    </Button>
                  )}
                  {wf.status === "PUBLISHED" && wf.isEnabled && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => action(wf, "pause")} loading={busy === `pause:${wf.id}`}>
                        <PauseCircle size={13} /> إيقاف مؤقت
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => action(wf, "stop")} loading={busy === `stop:${wf.id}`}>
                        <Square size={13} /> إيقاف
                      </Button>
                    </>
                  )}
                  {(!wf.isEnabled || wf.status !== "PUBLISHED") && (
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(wf)} className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
                      <Trash2 size={13} /> حذف
                    </Button>
                  )}
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {!loading && items.length === 0 && (
        <GlassCard>
          <EmptyState
            icon={<GitBranch size={28} strokeWidth={1.5} />}
            title="لا يوجد سير عمل بعد"
            description="أنشئ أول سير عمل: مشغّل + شروط + خطوات مرتبة مع محاكاة قبل النشر."
            action={<Button size="sm" onClick={() => setShowForm(true)}><Plus size={14} /> سير عمل جديد</Button>}
          />
        </GlassCard>
      )}

      {/* Builder dialog */}
      <Dialog open={showForm} onClose={() => setShowForm(false)} title="سير عمل جديد (مسودة)">
        <form onSubmit={create} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="الاسم">
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: ترحيب وتأهيل" />
            </Field>
            <Field label="المشغّل">
              <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                {TRIGGERS.map((tr) => <option key={tr} value={tr}>{enumLabel(tr)}</option>)}
              </Select>
            </Field>
          </div>

          <div className="space-y-2 rounded-xl border border-surface-3 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-ink">الشروط (وإلا تُسجّل المحاولة كمتخطاة)</p>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConditions((c) => [...c, { field: CONDITION_FIELDS[0], operator: "EQ", value: "" }])}>
                <Plus size={12} /> شرط
              </Button>
            </div>
            {conditions.map((c, i) => (
              <div key={i} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
                <Select value={c.field} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
                  {CONDITION_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                </Select>
                <Select value={c.operator} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))}>
                  {OPERATORS.map((op) => <option key={op} value={op}>{enumLabel(op)}</option>)}
                </Select>
                <Input value={String(c.value ?? "")} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} dir="ltr" />
                <Button type="button" size="sm" variant="ghost" onClick={() => setConditions((arr) => arr.filter((_, j) => j !== i))}><Trash2 size={12} /></Button>
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-xl border border-surface-3 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-ink">الخطوات (بالترتيب)</p>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSteps((s) => [...s, { ...EMPTY_STEP }])}>
                <Plus size={12} /> خطوة
              </Button>
            </div>
            {steps.map((s, i) => (
              <div key={i} className="space-y-2 rounded-lg bg-surface-2/60 p-2.5">
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                  <span className="num text-xs text-ink-subtle">{i + 1}</span>
                  <Select value={s.type} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { type: e.target.value } as StepForm : x)))}>
                    {STEP_TYPES.map((st) => <option key={st.value} value={st.value}>{st.label}</option>)}
                  </Select>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setSteps((arr) => arr.filter((_, j) => j !== i))}><Trash2 size={12} /></Button>
                </div>
                {(s.type === "SEND_MESSAGE" || s.type === "CREATE_FOLLOW_UP") && (
                  <Field label="نص الرسالة" hint="المتغيرات: {{customer.name}} وغيرها.">
                    <Textarea value={s.template ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, template: e.target.value } : x)))} rows={2} />
                  </Field>
                )}
                {s.type === "CREATE_FOLLOW_UP" && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="بعد (ساعات)"><Input type="number" min="0.01" step="0.01" value={s.delayHours ?? 24} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, delayHours: Number(e.target.value) } : x)))} dir="ltr" className="num" /></Field>
                    <Field label="النوع"><Input value={s.followUpType ?? "GENERIC"} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, followUpType: e.target.value } : x)))} dir="ltr" /></Field>
                  </div>
                )}
                {s.type === "CANCEL_FOLLOW_UPS" && (
                  <Field label="النوع (اختياري)"><Input value={s.followUpType ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, followUpType: e.target.value } : x)))} dir="ltr" /></Field>
                )}
                {(s.type === "ADD_TAG" || s.type === "REMOVE_TAG") && (
                  <Field label="الوسم"><Input value={s.tag ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, tag: e.target.value } : x)))} dir="ltr" /></Field>
                )}
                {s.type === "ASSIGN_CONVERSATION" && (
                  <Field label="معرّف الموظف"><Input value={s.agentId ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, agentId: e.target.value } : x)))} dir="ltr" /></Field>
                )}
                {s.type === "CREATE_NOTE" && (
                  <Field label="نص الملاحظة"><Textarea value={s.text ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} rows={2} /></Field>
                )}
                {s.type === "WAIT" && (
                  <Field label="مدة الانتظار (دقائق)"><Input type="number" min="1" value={s.minutes ?? 60} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)))} dir="ltr" className="num" /></Field>
                )}
                {s.type === "CHANGE_AI_STATE" && (
                  <Field label="الحالة الجديدة">
                    <Select value={s.aiState ?? "AI_ACTIVE"} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, aiState: e.target.value } : x)))}>
                      <option value="AI_ACTIVE">الذكاء نشط</option>
                      <option value="AI_PAUSED">الذكاء موقوف</option>
                    </Select>
                  </Field>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>إلغاء</Button>
            <Button type="submit" loading={creating} disabled={!canSubmit}><Send size={13} /> إنشاء كمسودة</Button>
          </div>
        </form>
      </Dialog>

      {/* Execution log dialog */}
      <Dialog open={!!detail} onClose={() => setDetail(null)} title={`التنفيذات — ${detail?.name ?? ""}`}>
        <div className="space-y-2">
          {(detail?.executions ?? []).map((ex) => (
            <div key={ex.id} className="rounded-xl border border-surface-3 p-3">
              <p className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-ink">
                <Badge tone={STATUS_TONE[ex.status] ?? ex.status}>{enumLabel(ex.status)}</Badge>
                <span className="num text-ink-muted">v{ex.version} · خطوة {ex.stepIndex}</span>
              </p>
              {ex.error && <p className="num mt-1 text-xs text-red-600 dark:text-red-400" dir="ltr">{ex.error}</p>}
              <p className="num mt-1 text-[11px] text-ink-subtle">{new Date(ex.startedAt).toLocaleString("ar")}</p>
            </div>
          ))}
          {(detail?.executions ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-ink-muted">لا توجد تنفيذات بعد.</p>
          )}
        </div>
      </Dialog>

      {/* Preview trace dialog */}
      <Dialog open={!!preview} onClose={() => setPreview(null)} title="محاكاة تنفيذ (بدون أي كتابة)">
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm">
            <PlayCircle size={16} className="text-brand-500" />
            الشروط مستوفاة: <b>{preview?.conditionsMet ? "نعم" : "لا"}</b>
          </p>
          {(preview?.steps ?? []).map((s, i) => (
            <div key={i} className="flex items-center justify-between rounded-xl border border-surface-3 px-3 py-2">
              <span className="num text-xs text-ink-muted" dir="ltr">{s.stepId} · {s.type}</span>
              <Badge tone={s.outcome === "WOULD_RUN" || s.outcome === "BRANCH_TAKEN" ? "CONNECTED" : s.outcome === "WOULD_WAIT" ? "PENDING" : "NORMAL"}>
                {enumLabel(s.outcome)}
              </Badge>
            </div>
          ))}
          <p className="text-[11px] text-ink-subtle">{preview?.note}</p>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void remove(deleteTarget.id)}
        title={`حذف سير العمل "${deleteTarget?.name ?? ""}"؟`}
        body="سيُحذف تعريف سير العمل نهائيًا ولن يُنفَّذ بعد الآن. سجلات التنفيذ السابقة تبقى محفوظة."
        confirmLabel="حذف نهائي"
        busy={busy === `delete:${deleteTarget?.id}`}
        danger
      />
    </div>
  );
}
