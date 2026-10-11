"use client";

import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, KeySquare, PlugZap, Save, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { GlassCard } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { CopyField, FixNote, HealthPill, InfoNote, RiskNote, RiskWithFix, apiJson, fmtDateTime, type Health } from "./ui";

export interface ConnectionView {
  system: string;
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  eventsUrl: string | null;
  effectiveEventsUrl: string | null;
  hasToken: boolean;
  hasEventsSecret: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface SystemInfo {
  key: string;
  nameAr: string;
  summaryAr: string;
  eventsPath: string | null;
  sendsEvents: string[];
  calls: Array<{ name: string; method: string; path: string; descAr: string }>;
  inbound: Array<{ method: string; path: string; descAr: string }>;
  needsToken: boolean;
  needsEventsSecret: boolean;
  connection: ConnectionView;
  stats: { pending: number; failed: number };
}

const EVENT_AR: Record<string, string> = {
  "conversation.coded": "محادثة برمز",
  "retarget.result": "نتيجة حملة",
  opt_out: "إلغاء اشتراك",
  "capacity.alert": "إنذار القدرة",
};

/** تنبيهات «مؤتمت» لكل نظام بالأحمر وتصحيحها بالبرتقالي (قاعدة المالك). */
const AUTOMATION_NOTES: Record<string, { risk: string; fix: string }> = {
  mediabuyer: {
    risk: "مؤتمت: إنذار القدرة بيخلّي الميديا باير يجمّد تكبير حملات الرسائل ويخفّضها 20%",
    fix: "حدود الإنذار من «إعدادات الربط» تحت — حطها حسب حجم فريقك حتى ما تتجمد الحملات على ضغط عادي.",
  },
  crisis: {
    risk: "مؤتمت: قناة انقطع توكنها أو ضغط حرج بيفتح إنذار عند الأزمات",
    fix: "راجع حد «حرج» بالإعدادات؛ الإنذار مرة بالساعة كحد أقصى لكل مستوى.",
  },
  tasks: {
    risk: "مؤتمت: التحويلات البشرية المتأخرة بتعمل مهمة يومية للمشرف",
    fix: "مهمة وحدة باليوم بين 9 الصبح و10 المسا بس — بلا أسماء زبائن.",
  },
  finance: {
    risk: "مؤتمت: تقرير يومي بتكلفة الموديلات والسيرفر بينكتب قيد بالمالية",
    fix: "كلفة السيرفر اليومية من الإعدادات (فاضية = ما بتنبعت)، وأي تقرير بلا تكاليف معروفة ما بينبعت أبدًا.",
  },
  bridge: {
    risk: "مؤتمت: إنذار القدرة بيوصل الوكيل الذكي وبيصحّيه (درجة «عاجل»)",
    fix: "ساعات الهدوء بالجسر (23:00–7:30) بتأجّله، والأرقام ما فيها ولا بيانات شخصية.",
  },
  clipper: {
    risk: "مؤتمت: كل محادثة بلشت برمز كليبر بتبعت «محادثة برمز» للكليبر، وكل زبون لغى الاشتراك بالرسائل بيوصله «إلغاء اشتراك» — وحملات الكليبر بتنعمل «جاهزة» هون",
    fix: "بلا اسم ولا رقم زبون (رمز + قناة + مرجع معتم بس). الحملات ما بتطلع قبل اعتمادها بصفحة الحملات إلا إذا فعّلت «اعتماد الكليبر يكفي» بالإعدادات — خليه مطفي إذا بدك تراجع كل حملة.",
  },
  workspace: {
    risk: "مؤتمت: كل يوم أحد بتنبعت فكرة أسبوعية لمساحة العمل من أكتر مواضيع أسئلة الزبائن",
    fix: "أعداد ومواضيع بس (السعر 12 · التوصيل 7) — ولا نص رسالة زبون. إذا ما بدك ياها، أوقف الاتصال من هون.",
  },
  s1: {
    risk: "مؤتمت: كل تعديل بقواعد منتج بسيستم 1 بيغيّر شو الذكاء بيقدر يقول فورًا (الممنوع بيترفض بالرد)",
    fix: "اربط كل منتج بمرجعه من تبويب «الامتثال» بصفحة المنتج، وراجع القواعد هناك بعد كل تحديث.",
  },
};

export function connHealth(c: ConnectionView): { health: Health; label: string } {
  if (!c.configured) return { health: "off", label: "مش مربوط" };
  if (!c.enabled) return { health: "off", label: "موقوف" };
  const ok = c.lastOkAt ? new Date(c.lastOkAt).getTime() : 0;
  const err = c.lastErrorAt ? new Date(c.lastErrorAt).getTime() : 0;
  if (err > ok) return { health: "error", label: "آخر محاولة فشلت" };
  return ok ? { health: "ok", label: "شغّال" } : { health: "warn", label: "ما انختبر لسا" };
}

export function SystemCard({ info, s1WebhookUrl, onSaved, onShowLog }: { info: SystemInfo; s1WebhookUrl: string | null; onSaved: () => void; onShowLog: (system: string) => void }) {
  const toast = useToast();
  const c = info.connection;
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? "");
  const [eventsUrl, setEventsUrl] = useState(c.eventsUrl ?? "");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(c.configured ? c.enabled : true);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(c.baseUrl ?? "");
    setEventsUrl(c.eventsUrl ?? "");
    setEnabled(c.configured ? c.enabled : true);
  }, [c]);

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const res = await apiJson<{ generatedEventsSecret: string | null }>(`/api/integrations/systems/${info.key}`, {
        method: "POST",
        json: {
          baseUrl: baseUrl.trim() || null,
          eventsUrl: eventsUrl.trim() || null,
          enabled,
          ...(token.trim() ? { token: token.trim() } : {}),
          ...(secret.trim() ? { eventsSecret: secret.trim() } : {}),
          ...extra,
        },
      });
      setToken("");
      setSecret("");
      if (res.generatedEventsSecret) setNewSecret(res.generatedEventsSecret);
      else toast.show(`انحفظ اتصال ${info.nameAr}`);
      onSaved();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل الحفظ", "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setProbe(null);
    try {
      const r = await apiJson<{ ok: boolean; detail: string }>(`/api/integrations/systems/${info.key}/test`, { method: "POST" });
      setProbe(`${r.ok ? "✓" : "✗"} ${r.detail}`);
      onSaved();
    } catch (err) {
      setProbe(err instanceof Error ? err.message : "فشل الفحص");
    } finally {
      setBusy(false);
    }
  }

  const h = connHealth(c);
  const auto = AUTOMATION_NOTES[info.key];
  const receivesEvents = info.sendsEvents.length > 0;
  return (
    <GlassCard className="flex flex-col gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">{info.nameAr}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{info.summaryAr}</p>
        </div>
        <HealthPill health={h.health}>{h.label}</HealthPill>
      </div>

      <div className="space-y-1 text-[11px] leading-relaxed text-ink-muted">
        {receivesEvents && (
          <p className="flex items-start gap-1.5">
            <ArrowUpFromLine size={12} className="mt-0.5 shrink-0 text-ink-subtle" />
            أحداث بنبعتها موقّعة: {info.sendsEvents.map((e) => EVENT_AR[e] ?? e).join(" · ")}
          </p>
        )}
        {info.calls.map((call) => (
          <p key={call.name} className="flex items-start gap-1.5">
            <Send size={12} className="mt-0.5 shrink-0 text-ink-subtle" />
            <span>
              {call.descAr} <span dir="ltr" className="font-mono text-ink-subtle">{call.method} {call.path}</span>
            </span>
          </p>
        ))}
        {info.inbound.map((inb) => (
          <p key={inb.path} className="flex items-start gap-1.5">
            <ArrowDownToLine size={12} className="mt-0.5 shrink-0 text-ink-subtle" />
            <span>
              {inb.descAr} <span dir="ltr" className="font-mono text-ink-subtle">{inb.method} {inb.path}</span>
            </span>
          </p>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="الرابط الأساسي" className="sm:col-span-2">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} dir="ltr" className="num" placeholder="https://…" inputMode="url" />
        </Field>
        {receivesEvents && (
          <Field label="رابط استقبال الأحداث (اختياري)" hint={info.eventsPath ? `فاضي = الرابط الأساسي + \u2066${info.eventsPath}\u2069` : undefined} className="sm:col-span-2">
            <Input value={eventsUrl} onChange={(e) => setEventsUrl(e.target.value)} dir="ltr" className="num" placeholder={c.effectiveEventsUrl ?? ""} inputMode="url" />
          </Field>
        )}
        {info.needsToken && (
          <Field label={`توكن ${info.nameAr} لنظام الردود`} hint={c.hasToken ? "محفوظ ومشفّر — فاضي = بلا تغيير" : "من شاشة التوكنات بالنظام التاني"}>
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} dir="ltr" autoComplete="off" placeholder={c.hasToken ? "••••••••" : ""} />
          </Field>
        )}
        {info.needsEventsSecret && (
          <Field label="سر توقيع الأحداث" hint={c.hasEventsSecret ? "محفوظ ومشفّر — فاضي = بلا تغيير" : "الصق سر النظام التاني، أو ولّد واحد وانسخه له"}>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} dir="ltr" autoComplete="off" placeholder={c.hasEventsSecret ? "••••••••" : ""} />
          </Field>
        )}
      </div>

      {info.key === "s1" && (
        <CopyField label="رابط استقبال أحداث سيستم 1 (compliance.updated) — الصقه بسيستم 1" value={s1WebhookUrl} hint="التوقيع بنفس «سر توقيع الأحداث» فوق." />
      )}

      {auto && c.configured && (
        <div className="space-y-1.5">
          <RiskNote title={auto.risk} />
          <FixNote>{auto.fix}</FixNote>
        </div>
      )}
      {info.key === "clipper" && (
        <RiskWithFix
          risk="الكليبر بيطلب حملات رسائل لزبائنك"
          detail="الحملة بتنحسب جوّا الردود من الموافقين بس، والكليبر بيستلم أعداد — ولا اسم ولا رقم."
          fix="افتراضيًا كل حملة بتستنى اعتمادك بصفحة الحملات. «اعتماد الكليبر يكفي» بالإعدادات بيلغي هالخطوة — خليه مطفي إلا إذا بتثق بالمراجعة هناك."
        />
      )}

      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-brand-500" /> الاتصال فعّال
      </label>

      {probe && <InfoNote>{probe}</InfoNote>}
      <p className="text-[11px] text-ink-subtle">
        آخر نجاح: {fmtDateTime(c.lastOkAt)}
        {c.lastError ? ` · آخر خطأ: ${c.lastError}` : ""}
        {info.stats.pending + info.stats.failed > 0 && (
          <>
            {" · "}
            <button type="button" onClick={() => onShowLog(info.key)} className={info.stats.failed > 0 ? "font-semibold text-red-600 underline-offset-2 hover:underline dark:text-red-400" : "underline-offset-2 hover:underline"}>
              {info.stats.pending} بالانتظار · {info.stats.failed} فشل
            </button>
          </>
        )}
      </p>

      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" onClick={() => save()} loading={busy} disabled={busy}>
          <Save size={13} />
          حفظ
        </Button>
        <Button size="sm" variant="secondary" onClick={test} disabled={busy || !c.configured}>
          <PlugZap size={13} />
          اختبر
        </Button>
        {info.needsEventsSecret && (
          <Button size="sm" variant="ghost" onClick={() => save({ generateEventsSecret: true })} disabled={busy}>
            <KeySquare size={13} />
            ولّد سر جديد
          </Button>
        )}
      </div>

      <Dialog open={Boolean(newSecret)} onClose={() => setNewSecret(null)} title="سر التوقيع الجديد — انسخه الآن" className="max-w-lg">
        <div className="space-y-3">
          <RiskNote title="السر بيظهر مرة وحدة — والسر القديم وقف هلأ.">النظام التاني لازم ياخد الجديد فورًا وإلا الأحداث بتنرفض عنده (401).</RiskNote>
          <FixNote>الصقه بإعدادات {info.nameAr} (متغير السر عنده) وبعدين اضغط «اختبر».</FixNote>
          <CopyField label="سر التوقيع" value={newSecret} />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setNewSecret(null)}>
              نسخته
            </Button>
          </div>
        </div>
      </Dialog>
    </GlassCard>
  );
}
