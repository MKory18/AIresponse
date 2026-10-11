"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardCopy, Link2, PackageCheck, Send, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { GlassCard } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { FixNote, HealthPill, RiskNote, apiJson, copyText, fmtDateTime } from "@/components/integrations/ui";

export interface OmsOrderFields {
  id: string;
  orderNumber: string;
  status: string;
  confirmationStatus: string;
  omsOrderId?: string | null;
  omsOrderNumber?: string | null;
  omsStatus?: string | null;
  omsStatusAt?: string | null;
  handoffMode?: string | null;
  channel?: string | null;
  attributionMethod?: string | null;
  adId?: string | null;
  refCode?: string | null;
  touchAt?: string | null;
}

export interface OmsConnSummary {
  mode: "api" | "manual" | string;
  isActive: boolean;
  autoHandoff: boolean;
}

/** حالة الترحيل كما يحسبها الخادم (بلا أسرار): الترحيل التلقائي · ربط يدوي ما طابق. */
export interface OmsOrderState {
  autoHandoff: { state: "queued" | "retrying" | "failed" | "refused" | "done"; attempts: number; lastError: string | null; nextAt: string | null } | null;
  linkIssue: { reason: string; omsTotal: number | null; omsCurrency: string | null; at: string } | null;
}

const LINK_ISSUE_AR: Record<string, string> = {
  CURRENCY: "عملة طلب الـ OMS غير عملة طلبنا",
  TOTAL: "مجموع طلب الـ OMS بعيد عن مجموع طلبنا",
  BEFORE_ORDER: "أحداث طلب الـ OMS أقدم من طلبنا نفسه",
};

const REFUSED_AR: Record<string, string> = {
  ORDER_CUSTOMER_BLACKLISTED: "الزبون بالقائمة السوداء",
  OMS_MANUAL_MODE: "الاتصال صار بالوضع اليدوي",
  OMS_NOT_CONFIGURED: "الـ OMS مش مربوط",
  ORDER_NOT_CONFIRMED: "الطلب مش مؤكد",
  NOT_FOUND: "الطلب مش موجود",
};

const OMS_NUMBER_RE = /^[A-Z0-9]{2,10}-[0-9]{4}-[0-9]{4,8}$/;
const normalizeNumber = (v: string) =>
  v
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[‐-―−－]/g, "-")
    .replace(/\s+/g, "")
    .replace(/^#+/, "")
    .toUpperCase();

const METHOD_AR: Record<string, string> = { AD: "إعلان", CODE: "رمز كليبر", NONE: "بلا مصدر معروف" };
const CHANNEL_AR: Record<string, string> = { whatsapp: "واتساب", messenger: "ماسنجر", instagram: "إنستغرام", telegram: "تيليغرام", tiktok: "تيك توك", web: "الموقع" };
const OMS_STATUS_AR: Record<string, string> = {
  NEW: "جديد",
  CONFIRMED: "مؤكد",
  SHIPPED: "مشحون",
  OUT_FOR_DELIVERY: "بالتوصيل",
  DELIVERED: "مُسلَّم",
  RETURNED: "مرتجع",
  CANCELLED: "ملغى",
  PROCESSING: "قيد التجهيز",
  READY_FOR_SHIPPING: "جاهز للشحن",
  REJECTED: "مرفوض",
};

export function OmsHandoffCard({
  order,
  oms,
  state,
  canWrite,
  onChanged,
}: {
  order: OmsOrderFields;
  oms: OmsConnSummary | null;
  state?: OmsOrderState | null;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [intake, setIntake] = useState<{ text: string; warnings: string[] } | null>(null);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const confirmed = order.confirmationStatus === "CONFIRMED_BY_CUSTOMER" || order.confirmationStatus === "CONFIRMED_BY_AGENT";
  const dead = order.status === "CANCELLED" || order.status === "FAILED";
  const normalized = normalizeNumber(number);
  const numberOk = OMS_NUMBER_RE.test(normalized);
  const auto = state?.autoHandoff ?? null;
  const linkIssue = state?.linkIssue ?? null;

  async function handoff() {
    setBusy(true);
    try {
      const r = await apiJson<{ handedOff?: boolean; omsOrderId?: string | null }>("/api/oms/handoff", { method: "POST", json: { orderId: order.id } });
      toast.show(r.handedOff === false ? "الطلب مرحّل من قبل" : "انرحّل للـ OMS");
      onChanged();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل الترحيل", "error");
    } finally {
      setBusy(false);
    }
  }

  async function loadIntake() {
    setBusy(true);
    try {
      const r = await apiJson<{ text: string; warnings: string[] }>(`/api/oms/manual/${order.id}`);
      setIntake(r);
      if (await copyText(r.text)) toast.show("انسخ النص — الصقه بشاشة «إدخال الطلب بالذكاء» بالـ OMS");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "تعذر تجهيز النص", "error");
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    setBusy(true);
    try {
      await apiJson(`/api/oms/manual/${order.id}`, { method: "POST", json: { omsOrderNumber: normalized } });
      toast.show("انربط — تحديثات الـ OMS (شحن · تسليم) بتوصل لحالها");
      setNumber("");
      setIntake(null);
      onChanged();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل الربط", "error");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await apiJson(`/api/oms/manual/${order.id}`, { method: "DELETE" });
      toast.show("انفك الربط اليدوي");
      onChanged();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل", "error");
    } finally {
      setBusy(false);
      setConfirmUnlink(false);
    }
  }

  return (
    <GlassCard className="space-y-3 p-4 text-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
          <PackageCheck size={15} />
        </span>
        الـ OMS
      </h2>

      {/* الإسناد — من وين إجا الطلب */}
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <HealthPill health={order.attributionMethod && order.attributionMethod !== "NONE" ? "ok" : "off"}>
          {METHOD_AR[order.attributionMethod ?? "NONE"] ?? order.attributionMethod}
        </HealthPill>
        {order.channel && <HealthPill health="off">{CHANNEL_AR[order.channel] ?? order.channel}</HealthPill>}
        {order.refCode && (
          <HealthPill health="off">
            رمز <span dir="ltr" className="font-mono">{order.refCode}</span>
          </HealthPill>
        )}
        {order.adId && (
          <HealthPill health="off">
            إعلان <span dir="ltr" className="font-mono">{order.adId}</span>
          </HealthPill>
        )}
      </div>

      {order.omsOrderId ? (
        <div className="space-y-2 text-xs">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
            <HealthPill health="ok">بالـ OMS</HealthPill>
            {order.omsOrderNumber ? <span dir="ltr" className="num">#{order.omsOrderNumber}</span> : null}
          </p>
          <p className="text-ink-muted">
            حالة الـ OMS: {order.omsStatus ? OMS_STATUS_AR[order.omsStatus] ?? order.omsStatus : "—"}
            {order.omsStatusAt ? ` · ${fmtDateTime(order.omsStatusAt)}` : ""}
          </p>
          {order.handoffMode === "manual" && canWrite && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmUnlink(true)} disabled={busy}>
              <Unlink size={13} />
              فك الربط (رقم غلط)
            </Button>
          )}
        </div>
      ) : order.omsOrderNumber ? (
        <div className="space-y-2 text-xs">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
            <HealthPill health={linkIssue ? "error" : "warn"}>مربوط يدويًا</HealthPill>
            <span dir="ltr" className="num">#{order.omsOrderNumber}</span>
          </p>
          {linkIssue ? (
            <>
              <RiskNote title={`أحداث الـ OMS للرقم ${order.omsOrderNumber} ما بتطابق هالطلب — الربط ما كمل`}>
                {LINK_ISSUE_AR[linkIssue.reason] ?? linkIssue.reason}
                {linkIssue.omsTotal !== null ? ` (مجموع الـ OMS ${linkIssue.omsTotal}${linkIssue.omsCurrency ? ` ${linkIssue.omsCurrency}` : ""})` : ""}. على الأغلب
                الرقم لطلب زبون تاني — حالته ما رح تسوق هالطلب.
              </RiskNote>
              <FixNote>افتح الطلب بالـ OMS وتأكد من رقمه، وبعدين «فك الربط» وحط الرقم الصح.</FixNote>
            </>
          ) : (
            <p className="text-ink-muted">أول حدث من الـ OMS (تأكيد · شحن) بيثبّت الربط لحاله — بعد ما يتأكد إن العملة والمجموع مطابقين.</p>
          )}
          {canWrite && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmUnlink(true)} disabled={busy}>
              <Unlink size={13} />
              فك الربط (رقم غلط)
            </Button>
          )}
        </div>
      ) : dead ? (
        <p className="text-xs text-ink-subtle">طلب ملغى — ما بينرحّل.</p>
      ) : !confirmed ? (
        <p className="text-xs text-ink-subtle">الترحيل بيصير بعد تأكيد الطلب.</p>
      ) : !oms || !oms.isActive ? (
        <p className="text-xs text-ink-muted">
          الـ OMS مش مربوط.{" "}
          <Link href="/settings/integrations" className="font-semibold text-brand-600 hover:underline dark:text-brand-300">
            اربطه من الإعدادات
          </Link>
        </p>
      ) : oms.mode === "api" ? (
        <div className="space-y-2">
          {auto?.state === "failed" ? (
            <>
              <RiskNote title={`الترحيل التلقائي فشل بعد ${auto.attempts} محاولات — الطلب لسا مش بالـ OMS`}>
                {auto.lastError ? <span dir="ltr" className="font-mono">{auto.lastError}</span> : null}
              </RiskNote>
              <FixNote>تأكد إن الـ OMS شغّال ورابطه صحيح، وبعدين «رحّل للـ OMS» — أو استنى: الكنس الساعي بيعيد المحاولة لحاله لمدة 3 أيام.</FixNote>
            </>
          ) : auto?.state === "retrying" ? (
            <>
              <RiskNote title={`الـ OMS ما رد — عم نعيد المحاولة (${auto.attempts})`}>
                {auto.lastError ? <span dir="ltr" className="font-mono">{auto.lastError}</span> : null}
                {auto.nextAt ? ` · المحاولة الجاية ${fmtDateTime(auto.nextAt)}` : ""}
              </RiskNote>
              <FixNote>ما في شي لازم تعمله إذا الـ OMS رجع — نفس مفتاح عدم التكرار بيمنع طلب مكرر هناك.</FixNote>
            </>
          ) : auto?.state === "refused" ? (
            <>
              <RiskNote title={`الترحيل التلقائي انرفض: ${REFUSED_AR[auto.lastError ?? ""] ?? auto.lastError ?? "رفض نهائي"}`} />
              <FixNote>صلّح السبب (القائمة السوداء · وضع الاتصال) وبعدين رحّل يدويًا بالزر.</FixNote>
            </>
          ) : oms.autoHandoff ? (
            <>
              <RiskNote title="مؤتمت: الطلب المؤكد بينرحّل للـ OMS لحاله بلا مراجعة موظف" />
              <FixNote>إذا بدك عين بشرية قبل الشحن، طفّي «ترحيل تلقائي» من الإعدادات ← الربط مع الأنظمة ← الـ OMS، ورحّل بالزر.</FixNote>
            </>
          ) : null}
          {canWrite && (
            <Button size="sm" onClick={handoff} loading={busy} disabled={busy}>
              <Send size={13} />
              رحّل للـ OMS
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          <RiskNote title="الطلب لسا ما وصل الـ OMS (وضع يدوي)" />
          <FixNote>انسخ نص الإدخال ← الصقه بشاشة «إدخال الطلب بالذكاء» بالـ OMS ← حط رقم الطلب يلي طلع هون.</FixNote>
          {canWrite && (
            <>
              <Button size="sm" variant="secondary" onClick={loadIntake} loading={busy && !intake} disabled={busy}>
                <ClipboardCopy size={13} />
                انسخ نص الإدخال
              </Button>
              {intake && (
                <div className="space-y-2">
                  <Textarea readOnly rows={6} value={intake.text} className="text-xs" aria-label="نص الإدخال للـ OMS" />
                  {intake.warnings.map((w) => (
                    <FixNote key={w}>{w}</FixNote>
                  ))}
                  <RiskNote title="النص فيه اسم الزبون ورقمه وعنوانه — مكانه شاشة الـ OMS بس">
                    إذا الـ OMS مضبوط فيه OPENROUTER_API_KEY، شاشة «الإدخال بالذكاء» بتبعته لموديل خارجي.
                  </RiskNote>
                  <FixNote>شيل المفتاح من بيئة الـ OMS (المحلّل المحلي بيقرأ هالصيغة لحاله) — أو انتقل لوضع API لما ينبنى الباب.</FixNote>
                </div>
              )}
              <div className="flex items-end gap-2">
                <Field
                  label="رقم الطلب بالـ OMS"
                  className="flex-1"
                  error={number && !numberOk ? "الشكل: حروف المتجر - السنة - الرقم (SY-2026-0148)" : undefined}
                >
                  <Input
                    value={number}
                    onChange={(e) => setNumber(e.target.value.toUpperCase())}
                    dir="ltr"
                    className="num"
                    maxLength={40}
                    placeholder="SY-2026-0148"
                    autoCapitalize="characters"
                    autoComplete="off"
                  />
                </Field>
                <Button size="sm" onClick={link} disabled={busy || !numberOk} className="mb-0.5">
                  <Link2 size={13} />
                  اربط
                </Button>
              </div>
              <RiskNote title="رقم غلط بيربط الطلب بطلب زبون تاني" />
              <FixNote>انسخ الرقم من صفحة الطلب بالـ OMS (مش من الذاكرة). الربط ما بيكمل إلا إذا عملة ومجموع أول حدث مطابقين — وإلا بيبين هون بالأحمر.</FixNote>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmUnlink}
        onClose={() => setConfirmUnlink(false)}
        onConfirm={unlink}
        title="فك الربط اليدوي؟"
        body="الطلب بيرجع «بانتظار النسخ للـ OMS» وتحديثات الشحن ما بتوصله لحد ما تربطه من جديد. إذا أحداث الرقم الغلط غيّرت حالة الطلب، راجعها يدويًا (مسجّلة بسجل الطلب)."
        confirmLabel="فك الربط"
        busy={busy}
        danger
      />
    </GlassCard>
  );
}
