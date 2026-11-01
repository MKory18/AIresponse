"use client";

import { useMemo, useState } from "react";
import { Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { label as enumLabel } from "@/lib/i18n";

/**
 * قاعدة بخطوات (كانت صفحة «سير العمل»): حدث + شروط + خطوات مرتبة. بتنحفظ مسودة
 * وما بتشتغل إلا بعد «تشغيل» من القائمة — وقبلها «محاكاة» بلا أي كتابة.
 */

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

const TRIGGERS = [
  "MESSAGE_RECEIVED", "CONVERSATION_CREATED", "CONVERSATION_STATUS_CHANGED",
  "CONVERSATION_ASSIGNED", "HANDOFF_CREATED", "CUSTOMER_TAGGED", "CUSTOMER_CREATED",
  "ORDER_CREATED", "ORDER_CONFIRMED", "ORDER_CANCELLED",
] as const;

/** حقول الشروط بأسماء بيفهمها صاحب المتجر — القيمة الداخلية بتضل هي هي. */
const CONDITION_FIELDS: [string, string][] = [
  ["conversation.status", "حالة المحادثة"],
  ["conversation.aiState", "حالة الذكاء بالمحادثة"],
  ["conversation.channelType", "القناة"],
  ["customer.tags", "وسوم العميل"],
  ["customer.isBlacklisted", "العميل محظور"],
  ["customer.leadScore", "درجة اهتمام العميل"],
  ["order.status", "حالة الطلب"],
  ["order.total", "مجموع الطلب"],
  ["event.minutesSinceLastCustomerMessage", "دقائق من آخر رسالة للعميل"],
];

const OPERATORS = ["EQ", "NEQ", "GT", "GTE", "LT", "LTE", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "EXISTS", "NOT_EXISTS"];

export const STEP_TYPES = [
  { value: "SEND_MESSAGE", label: "إرسال رسالة" },
  { value: "CREATE_NOTE", label: "ملاحظة داخلية" },
  { value: "CREATE_FOLLOW_UP", label: "جدولة متابعة" },
  { value: "CANCEL_FOLLOW_UPS", label: "إلغاء المتابعات" },
  { value: "ADD_TAG", label: "إضافة وسم" },
  { value: "REMOVE_TAG", label: "إزالة وسم" },
  { value: "ASSIGN_CONVERSATION", label: "إسناد المحادثة لموظف" },
  { value: "CHANGE_AI_STATE", label: "تشغيل/إيقاف الذكاء بالمحادثة" },
  { value: "WAIT", label: "انتظار (دقائق)" },
  { value: "STOP_WORKFLOW", label: "إنهاء القاعدة" },
] as const;

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

export function WorkflowBuilderDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState<string>("MESSAGE_RECEIVED");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [steps, setSteps] = useState<StepForm[]>([{ ...EMPTY_STEP }]);

  const canSubmit = useMemo(() => name.trim().length >= 2 && steps.length > 0, [name, steps.length]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
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
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? "فشل إنشاء القاعدة");
        return;
      }
      setName("");
      setDescription("");
      setConditions([]);
      setSteps([{ ...EMPTY_STEP }]);
      onCreated();
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="قاعدة بخطوات (بتنحفظ مسودة)">
      <form onSubmit={create} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="الاسم">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: ترحيب وتأهيل" />
          </Field>
          <Field label="لما يصير">
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGERS.map((tr) => <option key={tr} value={tr}>{enumLabel(tr)}</option>)}
            </Select>
          </Field>
          <Field label="وصف قصير (اختياري)" className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="شو بتعمل هالقاعدة؟" />
          </Field>
        </div>

        <div className="space-y-2 rounded-xl border border-line p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-ink">الشروط <span className="font-normal text-ink-muted">(اختياري — بلا شروط = كل مرة)</span></p>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConditions((c) => [...c, { field: CONDITION_FIELDS[0]![0], operator: "EQ", value: "" }])}>
              <Plus size={12} /> شرط
            </Button>
          </div>
          {conditions.map((c, i) => (
            <div key={i} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
              <Select value={c.field} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
                {CONDITION_FIELDS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </Select>
              <Select value={c.operator} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))}>
                {OPERATORS.map((op) => <option key={op} value={op}>{enumLabel(op)}</option>)}
              </Select>
              <Input value={String(c.value ?? "")} onChange={(e) => setConditions((arr) => arr.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} dir="ltr" aria-label="القيمة" />
              <Button type="button" size="sm" variant="ghost" aria-label="حذف الشرط" onClick={() => setConditions((arr) => arr.filter((_, j) => j !== i))}><Trash2 size={12} /></Button>
            </div>
          ))}
        </div>

        <div className="space-y-2 rounded-xl border border-line p-3">
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
                <Button type="button" size="sm" variant="ghost" aria-label="حذف الخطوة" onClick={() => setSteps((arr) => arr.filter((_, j) => j !== i))}><Trash2 size={12} /></Button>
              </div>
              {(s.type === "SEND_MESSAGE" || s.type === "CREATE_FOLLOW_UP") && (
                <Field label="نص الرسالة" hint="{{customer.name}} = اسم العميل.">
                  <Textarea value={s.template ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, template: e.target.value } : x)))} rows={2} />
                </Field>
              )}
              {s.type === "CREATE_FOLLOW_UP" && (
                <Field label="بعد (ساعات)"><Input type="number" min="0.01" step="0.01" value={s.delayHours ?? 24} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, delayHours: Number(e.target.value) } : x)))} dir="ltr" className="num" /></Field>
              )}
              {(s.type === "ADD_TAG" || s.type === "REMOVE_TAG") && (
                <Field label="الوسم"><Input value={s.tag ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, tag: e.target.value } : x)))} /></Field>
              )}
              {s.type === "ASSIGN_CONVERSATION" && (
                <Field label="معرّف الموظف" hint="من صفحة «الفريق»."><Input value={s.agentId ?? ""} onChange={(e) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, agentId: e.target.value } : x)))} dir="ltr" /></Field>
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

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>إلغاء</Button>
          <Button type="submit" loading={creating} disabled={!canSubmit}><Send size={13} /> حفظ كمسودة</Button>
        </div>
      </form>
    </Dialog>
  );
}
