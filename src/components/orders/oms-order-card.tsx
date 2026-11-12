"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { FixNote, RiskNote } from "@/components/integrations/ui";

type OmsState = {
  connected: boolean;
  sent: boolean;
  omsOrderNumber: string | null;
  omsStatus: string | null;
  handedOffAt: string | null;
  priceAdjusted: boolean;
  omsTotal: number | null;
  omsCurrency: string | null;
  job: { state: "queued" | "retrying" | "failed" | "refused" | "done"; attempts: number; lastError: string | null } | null;
  canSend: boolean;
};

/**
 * الطلب بالـ OMS: رقمه هناك، أو ليش لسا ما انبعت — وزر «ابعته هلأ».
 * ما بيظهر إذا الـ OMS مش مربوط وما انبعت الطلب أصلًا.
 */
export function OmsOrderCard({ orderId, cancelled }: { orderId: string; cancelled: boolean }) {
  const [state, setState] = useState<OmsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/${orderId}/oms`).catch(() => null);
    if (res?.ok) setState((await res.json()) as OmsState);
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/oms`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "ما انبعت للـ OMS");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ما انبعت للـ OMS");
    } finally {
      setBusy(false);
      void load();
    }
  }

  if (!state || (!state.connected && !state.sent)) return null;

  const pending = !state.sent && !cancelled;
  const failed = state.job && (state.job.state === "failed" || state.job.state === "refused");

  return (
    <GlassCard className="space-y-2 p-4 text-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
          <Boxes size={15} />
        </span>
        الـ OMS
      </h2>
      {state.sent ? (
        <>
          <p className="text-xs text-ink-subtle">رقم الطلب بالـ OMS</p>
          <p className="num font-bold text-ink" dir="ltr">{state.omsOrderNumber ?? "—"}</p>
          {state.omsStatus && <p className="text-xs text-ink-muted">الحالة هناك: {state.omsStatus}</p>}
          {state.handedOffAt && <p className="text-xs text-ink-subtle">انبعت: {new Date(state.handedOffAt).toLocaleString("ar")}</p>}
          {state.priceAdjusted && (
            <>
              <RiskNote title="الـ OMS سعّر الطلب غير سعرنا">
                المجموع المعتمد بالـ OMS:{" "}
                <span className="num" dir="ltr">
                  {state.omsTotal ?? "—"} {state.omsCurrency ?? ""}
                </span>
              </RiskNote>
              <FixNote>بلّغ الزبون بالسعر الصحيح قبل الشحن، وتأكد إن سعر المنتج بالـ OMS هو المقصود.</FixNote>
            </>
          )}
        </>
      ) : cancelled ? (
        <p className="text-xs text-ink-muted">الطلب ملغي — ما بينبعت للـ OMS.</p>
      ) : (
        <>
          <p className="text-xs text-ink-muted">
            {state.job?.state === "queued"
              ? "بالطريق للـ OMS…"
              : state.job?.state === "retrying"
                ? `الـ OMS ما رد — بنعيد المحاولة (${state.job.attempts})`
                : "لسا ما انبعت للـ OMS."}
          </p>
          {failed && (
            <>
              <RiskNote title="الطلب ما نزل بالـ OMS">{state.job?.lastError ?? "سبب غير معروف"}</RiskNote>
              <FixNote>صلّح السبب (رقم الزبون · المنتج موجود بالـ OMS) وبعدين اضغط «ابعته للـ OMS».</FixNote>
            </>
          )}
        </>
      )}
      {pending && state.canSend && state.connected && (
        <Button size="sm" variant="secondary" onClick={() => void send()} loading={busy} disabled={busy}>
          ابعته للـ OMS
        </Button>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </GlassCard>
  );
}
