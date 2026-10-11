"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardCopy, Link2, PackageCheck, Send, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { GlassCard } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { FixNote, HealthPill, InfoNote, RiskNote, apiJson, copyText, fmtDateTime } from "@/components/integrations/ui";

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

export function OmsHandoffCard({ order, oms, canWrite, onChanged }: { order: OmsOrderFields; oms: OmsConnSummary | null; canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [intake, setIntake] = useState<{ text: string; warnings: string[] } | null>(null);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const confirmed = order.confirmationStatus === "CONFIRMED_BY_CUSTOMER" || order.confirmationStatus === "CONFIRMED_BY_AGENT";
  const dead = order.status === "CANCELLED" || order.status === "FAILED";

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
      await apiJson(`/api/oms/manual/${order.id}`, { method: "POST", json: { omsOrderNumber: number.trim() } });
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
        <div className="space-y-1 text-xs">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
            <HealthPill health="ok">بالـ OMS</HealthPill>
            {order.omsOrderNumber ? <span dir="ltr" className="num">#{order.omsOrderNumber}</span> : null}
          </p>
          <p className="text-ink-muted">
            حالة الـ OMS: {order.omsStatus ? OMS_STATUS_AR[order.omsStatus] ?? order.omsStatus : "—"}
            {order.omsStatusAt ? ` · ${fmtDateTime(order.omsStatusAt)}` : ""}
          </p>
        </div>
      ) : order.omsOrderNumber ? (
        <div className="space-y-2 text-xs">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">
            <HealthPill health="warn">مربوط يدويًا</HealthPill>
            <span dir="ltr" className="num">#{order.omsOrderNumber}</span>
          </p>
          <p className="text-ink-muted">أول حدث من الـ OMS (تأكيد · شحن) بيثبّت الربط لحاله.</p>
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
          {oms.autoHandoff && <InfoNote>الترحيل التلقائي مفعّل — الطلب بينرحّل لحاله خلال دقيقة.</InfoNote>}
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
                  <InfoNote>النص فيه اسم الزبون ورقمه وعنوانه — مكانه شاشة الـ OMS بس.</InfoNote>
                </div>
              )}
              <div className="flex items-end gap-2">
                <Field label="رقم الطلب بالـ OMS" className="flex-1">
                  <Input value={number} onChange={(e) => setNumber(e.target.value)} dir="ltr" className="num" maxLength={40} placeholder="مثلًا 78120" />
                </Field>
                <Button size="sm" onClick={link} disabled={busy || number.trim().length < 2} className="mb-0.5">
                  <Link2 size={13} />
                  اربط
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmUnlink}
        onClose={() => setConfirmUnlink(false)}
        onConfirm={unlink}
        title="فك الربط اليدوي؟"
        body="الطلب بيرجع «بانتظار النسخ للـ OMS» وتحديثات الشحن ما بتوصله لحد ما تربطه من جديد."
        confirmLabel="فك الربط"
        busy={busy}
        danger
      />
    </GlassCard>
  );
}
