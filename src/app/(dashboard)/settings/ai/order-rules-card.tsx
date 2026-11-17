"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, ClipboardCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RiskWithFix } from "@/components/integrations/ui";
import { cn } from "@/lib/cn";
import type { ShadowReadiness } from "@/modules/orders/reader/cutover";

/**
 * «قواعد الطلب» (الحزمة 1.9، §12/§14) — وضع قارئ الطلب + إعداداته + معيار القطع بالأرقام.
 * القطع قرار المالك: تغيير الوضع للمالك فقط، والتحويل لـ «القارئ شغّال» بيطلب تأكيد مراجعة العيّنة
 * (وتأكيد المخاطر إذا المعيار ما اكتمل) وبيسكّر المسودات المفتوحة. الرجوع بكبسة: ولا شي بينحذف.
 */
type Mode = "LEGACY_DRAFT" | "READER_SHADOW" | "READER";
type Rules = {
  orderMode: Mode;
  orderSettleMinutes: number;
  orderAutoSeal: boolean;
  orderAgreementPolicy: "EXPLICIT_OR_IMPLICIT" | "EXPLICIT_ONLY";
  orderConfirmMessage: boolean;
};
type Payload = { settings: Rules; readiness: ShadowReadiness; canChangeMode: boolean };

const MODES: Array<{ key: Mode; title: string; hint: string }> = [
  { key: "LEGACY_DRAFT", title: "المسودة (الحالي)", hint: "الطلب بيتسجّل بالمسودة القديمة. القارئ مطفي بالكامل." },
  { key: "READER_SHADOW", title: "الظل", hint: "القارئ بيقرأ المحادثات وبيحفظ قراءاته بس — ولا طلب ولا رسالة ولا تغيير بالرد. 3 أيام على الأقل قبل التفعيل." },
  { key: "READER", title: "القارئ شغّال", hint: "القارئ بيسجّل الطلب من المحادثة، والوكيل بيبيع بنداء واحد، والتثبيت بعد المهلة." },
];

async function api(method: "GET" | "PATCH", body?: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch("/api/settings/order-rules", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { message: "تعذّر الاتصال بالخادم" } };
  }
}

const ERRORS: Record<string, string> = {
  OWNER_ONLY: "تغيير الوضع للمالك فقط.",
  REVIEW_CONFIRMATION_REQUIRED: "أكّد إنك راجعت عيّنة المحادثات.",
  READINESS_NOT_MET: "معيار القطع ما اكتمل — أكّد إنك فاهم المخاطر أو كمّل الظل.",
};

export function OrderRulesCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("LEGACY_DRAFT");
  const [rules, setRules] = useState<Omit<Rules, "orderMode"> | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [risks, setRisks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api("GET");
    if (!r.ok) return setError("تعذّر تحميل قواعد الطلب.");
    const p = r.data as Payload;
    setData(p);
    setMode(p.settings.orderMode);
    const { orderMode: _m, ...rest } = p.settings;
    void _m;
    setRules(rest);
    setError(null);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <GlassCard className="p-4 text-sm text-red-700 dark:text-red-300">{error}</GlassCard>;
  if (!data || !rules) return <Skeleton className="h-40 rounded-2xl" />;

  const current = data.settings.orderMode;
  const readiness = data.readiness;
  const toReader = mode === "READER" && current !== "READER";
  const modeDirty = mode !== current;
  const rulesDirty = (Object.keys(rules) as Array<keyof typeof rules>).some((k) => rules[k] !== data.settings[k]);

  async function save(patch: Record<string, unknown>, okText: string) {
    setBusy(true);
    setNotice(null);
    const r = await api("PATCH", patch);
    setBusy(false);
    if (!r.ok) {
      const code = r.data?.code ?? r.data?.error?.code;
      return setNotice({ ok: false, text: ERRORS[code as string] ?? r.data?.message ?? "تعذّر الحفظ" });
    }
    const extra: string[] = [];
    if (r.data.retiredDrafts > 0) extra.push(`اتسكّرت ${r.data.retiredDrafts} مسودة مفتوحة`);
    if (r.data.awaitingOrders > 0) extra.push(`${r.data.awaitingOrders} طلب بيستنى تثبيت يدوي من موظف`);
    setNotice({ ok: true, text: [okText, ...extra].join(" · ") });
    setReviewed(false);
    setRisks(false);
    await load();
  }

  return (
    <GlassCard
      className="space-y-4 p-4 sm:p-5"
      data-order-rules
      // البطاقة جوّا نموذج إعدادات الذكاء: Enter بحقل رقم ما بيحفظ نموذج تاني.
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
      }}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
          <ClipboardCheck size={15} />
        </span>
        <div>
          <h2 className="text-sm font-bold text-ink">قواعد الطلب</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-subtle">كيف بيتسجّل الطلب من المحادثة: بالمسودة القديمة، ولا بالقارئ الجديد؟ الرجوع بأي لحظة بكبسة، وما بينحذف شي.</p>
        </div>
      </div>

      {/* الوضع */}
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="وضع قارئ الطلب">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={mode === m.key}
            disabled={!data.canChangeMode || busy}
            onClick={() => setMode(m.key)}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-start transition disabled:cursor-not-allowed disabled:opacity-60",
              mode === m.key ? "border-primary/50 bg-primary-soft" : "border-line bg-surface-3/40 hover:bg-surface-hover"
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-bold text-ink">
              {m.title}
              {current === m.key && <span className="rounded-md bg-emerald-500/15 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-300">الحالي</span>}
            </span>
            <span className="mt-0.5 block text-[11px] leading-5 text-ink-muted">{m.hint}</span>
          </button>
        ))}
      </div>
      {!data.canChangeMode && <p className="text-[11px] text-ink-subtle">تغيير الوضع للمالك فقط. بقية الإعدادات تحت بتقدر تعدّلها.</p>}

      {mode === "READER_SHADOW" && (
        <RiskWithFix risk="الظل بيضيف نداء ذكاء بالخلفية لكل محادثة فيها طلب محتمل" fix="فلتر مجاني بيمنع النداء على الدردشة العادية؛ وإذا بدك توقف كلفته ارجع لـ «المسودة»." />
      )}
      {mode === "READER" && (
        <RiskWithFix
          risk="مؤتمت: الطلب النظيف بيتثبّت وبينبعت للـ OMS وتيليجرام بعد المهلة بلا مراجعة"
          fix="طفّي «التثبيت التلقائي» تحت، وكل طلب بيستنى زر «ثبّت الآن». والرجوع لـ «المسودة» بأي لحظة."
        />
      )}

      {/* معيار القطع */}
      {current !== "READER" && (
        <div className="space-y-1.5 rounded-xl border border-line bg-surface-3/40 p-3">
          <p className="text-xs font-bold text-ink">معيار القطع (من بيانات الظل)</p>
          <ul className="space-y-1.5">
            {readiness.criteria.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-[11px]">
                {c.ok === true ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" /> : c.ok === false ? <XCircle size={14} className="mt-0.5 shrink-0 text-red-600" /> : <CircleDashed size={14} className="mt-0.5 shrink-0 text-ink-subtle" />}
                <span>
                  <span className="font-semibold text-ink">{c.label}</span>
                  <span className="block text-ink-muted">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* تأكيد التحويل لـ READER */}
      {toReader && data.canChangeMode && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
          <label className="flex items-start gap-2 text-xs text-ink">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand-500" />
            <span>راجعت عيّنة 30 محادثة بنفسي (أو المبرمج) ولا طلب غلط.</span>
          </label>
          {!readiness.computedOk && (
            <label className="flex items-start gap-2 text-xs text-ink">
              <input type="checkbox" checked={risks} onChange={(e) => setRisks(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand-500" />
              <span>فاهم إن معيار القطع فوق ما اكتمل، وبفعّل على مسؤوليتي.</span>
            </label>
          )}
          <p className="text-[11px] text-ink-subtle">التفعيل بيسكّر المسودات المفتوحة (مع سطر تدقيق لكل وحدة). ما بينحذف شي.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={toReader ? "danger" : "primary"}
          disabled={busy || !modeDirty || !data.canChangeMode || (toReader && (!reviewed || (!readiness.computedOk && !risks)))}
          onClick={() => save({ orderMode: mode, ...(toReader ? { confirmReviewed: reviewed, acknowledgeRisks: risks } : {}) }, toReader ? "تم تفعيل القارئ" : "تم تغيير الوضع")}
        >
          {toReader ? "فعّل القارئ" : "طبّق الوضع"}
        </Button>
        {current === "READER" && <span className="text-[11px] text-ink-subtle">للرجوع: اختار «المسودة» وطبّق.</span>}
      </div>

      {/* الإعدادات */}
      <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-ink">
          مهلة التثبيت (دقايق)
          <input
            type="number"
            min={2}
            max={120}
            value={rules.orderSettleMinutes}
            onChange={(e) => setRules((r) => (r ? { ...r, orderSettleMinutes: Number(e.target.value) } : r))}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm"
          />
          <span className="mt-1 block font-normal text-ink-subtle">⚠️ أقصر = طلبات أسرع وتعديلات أكتر بعد الإرسال · 🔧 10 بتغطي «غيّرت رأيي بعد دقيقتين».</span>
        </label>
        <label className="block text-xs font-semibold text-ink">
          الموافقة المطلوبة
          <select
            value={rules.orderAgreementPolicy}
            onChange={(e) => setRules((r) => (r ? { ...r, orderAgreementPolicy: e.target.value as Rules["orderAgreementPolicy"] } : r))}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm"
          >
            <option value="EXPLICIT_OR_IMPLICIT">صريحة أو ضمنية</option>
            <option value="EXPLICIT_ONLY">صريحة بس</option>
          </select>
          <span className="mt-1 block font-normal text-ink-subtle">⚠️ الضمنية = عميل بعت بياناته وما قال «اي» بيتثبّت طلبه · 🔧 اختار «صريحة بس» إذا بدك تأكيد واضح.</span>
        </label>
        <label className="flex items-start gap-2 text-xs text-ink">
          <input type="checkbox" checked={rules.orderAutoSeal} onChange={(e) => setRules((r) => (r ? { ...r, orderAutoSeal: e.target.checked } : r))} className="mt-0.5 h-4 w-4 accent-brand-500" />
          <span>
            <span className="font-semibold">التثبيت التلقائي</span>
            <span className="block text-ink-subtle">⚠️ مؤتمت: الطلب النظيف بيتثبّت وبينبعت بلا مراجعة · 🔧 طفّيه وكل طلب بيستنى زر «ثبّت الآن».</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-ink">
          <input type="checkbox" checked={rules.orderConfirmMessage} onChange={(e) => setRules((r) => (r ? { ...r, orderConfirmMessage: e.target.checked } : r))} className="mt-0.5 h-4 w-4 accent-brand-500" />
          <span>
            <span className="font-semibold">رسالة التثبيت للعميل</span>
            <span className="block text-ink-subtle">نص ثابت برقم الطلب بينبعت للعميل لما يتثبّت طلبه.</span>
          </span>
        </label>
      </div>
      <div>
        <Button type="button" size="sm" variant="secondary" disabled={busy || !rulesDirty} onClick={() => save({ ...rules }, "تم حفظ القواعد")}>
          احفظ القواعد
        </Button>
      </div>

      {notice && (
        <p role="status" className={cn("text-xs font-semibold", notice.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-300")}>
          {notice.text}
        </p>
      )}
    </GlassCard>
  );
}
