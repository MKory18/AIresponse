"use client";

import { useEffect, useState } from "react";
import { PackageCheck, PlugZap, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { GlassCard } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { CopyField, HealthPill, InfoNote, RiskWithFix, SectionHead, apiJson, fmtDateTime, type Health } from "./ui";

export interface OmsView {
  configured: boolean;
  baseUrl: string | null;
  isActive: boolean;
  mode: "api" | "manual";
  apiVersion: "legacy" | "v1";
  autoHandoff: boolean;
  hasToken: boolean;
  hasWebhookSecret: boolean;
  webhookUrl: string | null;
  webhookPath: string | null;
  events: string[];
  lastWebhookAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

const EVENT_AR: Record<string, string> = {
  "order.created": "طلب جديد",
  "order.confirmed": "تأكيد",
  "order.shipped": "شحن",
  "order.delivered": "تسليم",
  "order.returned": "مرتجع",
  "order.cancelled": "إلغاء",
};

export function omsHealth(v: OmsView): { health: Health; label: string } {
  if (!v.configured) return { health: "off", label: "مش مربوط" };
  if (!v.isActive) return { health: "off", label: "موقوف" };
  const ok = v.lastOkAt || v.lastWebhookAt ? Math.max(new Date(v.lastOkAt ?? 0).getTime(), new Date(v.lastWebhookAt ?? 0).getTime()) : 0;
  const err = v.lastErrorAt ? new Date(v.lastErrorAt).getTime() : 0;
  if (err > ok) return { health: "error", label: "آخر محاولة فشلت" };
  if (v.mode === "manual") return { health: "warn", label: "وضع يدوي" };
  return ok ? { health: "ok", label: "شغّال" } : { health: "warn", label: "ما انختبر لسا" };
}

export function OmsCard({ view, appUrl, onSaved }: { view: OmsView; appUrl: string | null; onSaved: () => void }) {
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState(view.baseUrl ?? "");
  const [mode, setMode] = useState<OmsView["mode"]>(view.configured ? view.mode : "manual");
  const [apiVersion, setApiVersion] = useState<OmsView["apiVersion"]>(view.apiVersion);
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [autoHandoff, setAutoHandoff] = useState(view.autoHandoff);
  const [isActive, setIsActive] = useState(view.configured ? view.isActive : true);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const [rotate, setRotate] = useState(false);

  useEffect(() => {
    setBaseUrl(view.baseUrl ?? "");
    setMode(view.configured ? view.mode : "manual");
    setApiVersion(view.apiVersion);
    setAutoHandoff(view.autoHandoff);
    setIsActive(view.configured ? view.isActive : true);
  }, [view]);

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await apiJson("/api/oms/connection", {
        method: "POST",
        json: {
          baseUrl: baseUrl.trim(),
          mode,
          apiVersion,
          isActive,
          autoHandoff: mode === "api" ? autoHandoff : false,
          ...(token.trim() ? { token: token.trim() } : {}),
          ...(secret.trim() ? { webhookSecret: secret.trim() } : {}),
          ...extra,
        },
      });
      setToken("");
      setSecret("");
      toast.show("انحفظ اتصال الـ OMS");
      onSaved();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل الحفظ", "error");
    } finally {
      setBusy(false);
      setRotate(false);
    }
  }

  async function test() {
    setBusy(true);
    setProbe(null);
    try {
      const r = await apiJson<{ detail: string }>("/api/oms/connection/test", { method: "POST" });
      setProbe(r.detail);
      onSaved();
    } catch (err) {
      setProbe(err instanceof Error ? err.message : "فشل الفحص");
    } finally {
      setBusy(false);
    }
  }

  const h = omsHealth(view);
  return (
    <GlassCard className="space-y-4 p-4 sm:p-5">
      <SectionHead
        icon={<PackageCheck size={15} />}
        title="Zaki OMS — الطلبات"
        sub="الـ OMS مالك الطلب بعد التأكيد: الأسعار والعروض والقائمة السوداء والشحن. الردود بترحّل الطلب المؤكد وبتستقبل حالاته."
        action={<HealthPill health={h.health}>{h.label}</HealthPill>}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="رابط الـ OMS" hint={"مثلًا \u2066https://oms.zakai.io\u2069 — عنوان داخلي بنفس السيرفر يحتاج \u2066INTEGRATIONS_ALLOW_PRIVATE_NETWORK=true\u2069 بالخادم"}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} dir="ltr" className="num" placeholder="https://oms.example.com" inputMode="url" />
        </Field>
        <Field label="طريقة الترحيل">
          <Select value={mode} onChange={(e) => setMode(e.target.value as OmsView["mode"])}>
            <option value="manual">يدوي — نسخ نص الطلب للـ OMS (المتاح اليوم)</option>
            <option value="api">API — ترحيل مباشر (يحتاج باب /api/v1 بالـ OMS)</option>
          </Select>
        </Field>
        {mode === "api" && (
          <>
            <Field label="نسخة الباب">
              <Select value={apiVersion} onChange={(e) => setApiVersion(e.target.value as OmsView["apiVersion"])}>
                <option value="v1">v1 — عقد المنظومة (/api/v1)</option>
                <option value="legacy">قديم — المسارات الأولى</option>
              </Select>
            </Field>
            <Field label="توكن الـ OMS" hint={view.hasToken ? "محفوظ ومشفّر — اتركه فاضي لبلا تغيير" : "توكن الـ OMS لنظام الردود"}>
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} dir="ltr" autoComplete="off" placeholder={view.hasToken ? "••••••••" : ""} />
            </Field>
          </>
        )}
        <Field label="سر توقيع أحداث الـ OMS" hint={view.hasWebhookSecret ? "محفوظ ومشفّر — اتركه فاضي لبلا تغيير" : "من الـ OMS: الإعدادات ← التطبيقات ← التطبيق ← سر التوقيع (16 حرف على الأقل)"}>
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} dir="ltr" autoComplete="off" placeholder={view.hasWebhookSecret ? "••••••••" : ""} />
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-brand-500" /> الاتصال فعّال
          </label>
          <label className={`flex items-center gap-2 text-sm font-medium ${mode === "api" ? "cursor-pointer text-ink" : "cursor-not-allowed text-ink-subtle"}`}>
            <input type="checkbox" checked={mode === "api" && autoHandoff} disabled={mode !== "api"} onChange={(e) => setAutoHandoff(e.target.checked)} className="h-4 w-4 accent-red-500" />
            ترحيل تلقائي بعد التأكيد
          </label>
        </div>
      </div>

      {mode === "api" && autoHandoff && (
        <RiskWithFix
          risk="مؤتمت: كل طلب مؤكد بينبعت للـ OMS لحاله بلا مراجعة موظف"
          detail="الطلب الغلط (عنوان ناقص · كمية غلط) بيوصل الشحن قبل ما حدا يشوفه."
          fix="إذا بدك عين بشرية قبل الشحن: طفّي الترحيل التلقائي ورحّل من صفحة الطلب بزر «رحّل للـ OMS» — أو خلي التأكيد بالـ OMS نفسه."
        />
      )}
      {mode === "manual" && (
        <RiskWithFix
          risk="الوضع اليدوي: الطلبات المؤكدة ما بتنتقل للـ OMS لحالها"
          detail="الـ OMS الحالي ما فيه باب استقبال طلبات من نظام تاني (/api/v1) — بس فيه أحداث التطبيقات الطالعة."
          fix={
            <>
              من صفحة كل طلب مؤكد: «انسخ نص الإدخال» ← الصقه بشاشة «إدخال الطلب بالذكاء» بالـ OMS ← ارجع حط رقم الطلب هون. بعدها أحداث الـ OMS (شحن · تسليم · مرتجع)
              بتحدّث الطلب هون لحالها. البنود المنتظرة بتظهر بطابور المالك وبتنبيه Hermes. ولما ينبنى الباب بالـ OMS (برومبت GLM جاهز بالتوثيق) بدّل لـ API.
            </>
          }
        />
      )}
      <RiskWithFix
        risk="الـ OMS عنده إنبوكس واتساب خاص فيه"
        detail="إذا نفس رقم الواتساب أو نفس صفحة الفيسبوك مربوطة بالـ OMS وبالردود، الزبون بيستلم ردّين وبتضيع المحادثة بين نظامين."
        fix="اربط أرقام وصفحات المراسلة بنظام الردود بس، والـ OMS بيستقبل الطلبات بالترحيل. إنبوكس الـ OMS خلّيه لمتابعة الشحن من فريق التوصيل فقط أو اطفيه."
      />

      <div className="space-y-2 rounded-xl border border-line/70 p-3">
        <p className="text-xs font-bold text-ink">أحداث الـ OMS ← الردود</p>
        <CopyField
          label="رابط الاستقبال — الصقه بالـ OMS (الإعدادات ← التطبيقات ← رابط الـ Webhook)"
          value={view.webhookUrl ?? (view.webhookPath ? `${appUrl ?? ""}${view.webhookPath}` : null)}
          hint={view.webhookPath ? "الرابط سرّي (فيه مفتاح المساحة) — والتوقيع بسر التطبيق إلزامي فوقه." : "احفظ الاتصال أول مرة ليتولّد الرابط."}
        />
        <p className="flex flex-wrap gap-1 text-[11px] text-ink-muted">
          {view.events.map((e) => (
            <span key={e} className="rounded-full bg-surface-3 px-2 py-0.5">
              {EVENT_AR[e] ?? e}
            </span>
          ))}
        </p>
        <p className="text-[11px] text-ink-subtle">
          آخر حدث: {fmtDateTime(view.lastWebhookAt)} · آخر نجاح: {fmtDateTime(view.lastOkAt)}
          {view.lastError ? ` · آخر خطأ: ${view.lastError}` : ""}
        </p>
      </div>

      {probe && <InfoNote>{probe}</InfoNote>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => save()} loading={busy} disabled={busy || !baseUrl.trim()}>
          <Save size={14} />
          حفظ
        </Button>
        <Button variant="secondary" onClick={test} disabled={busy || !view.configured}>
          <PlugZap size={14} />
          اختبر الاتصال
        </Button>
        {view.webhookPath && (
          <Button variant="ghost" onClick={() => setRotate(true)} disabled={busy}>
            <RefreshCw size={14} />
            تغيير رابط الاستقبال
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={rotate}
        onClose={() => setRotate(false)}
        onConfirm={() => save({ rotateWebhookKey: true })}
        title="تغيير رابط استقبال أحداث الـ OMS؟"
        body="الرابط القديم بيوقف فورًا — لازم تلصق الجديد بالـ OMS وإلا الحالات (شحن · تسليم) ما بتوصل."
        confirmLabel="غيّر الرابط"
        busy={busy}
        danger
      />
    </GlassCard>
  );
}
