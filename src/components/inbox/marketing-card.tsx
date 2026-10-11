"use client";

import { useCallback, useEffect, useState } from "react";
import { BellOff, BellRing, Megaphone } from "lucide-react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm";
import { GlassCard } from "../ui/card";
import { useToast } from "../ui/toast";
import { HealthPill, apiJson, fmtDateTime } from "../integrations/ui";

interface MarketingView {
  consent: string;
  consentAt: string | null;
  optOutAt: string | null;
  consentSource: string | null;
  attribution: { channel: string; kind: string; source: string; adId: string | null; refCode: string | null; codeStatus: string | null; occurredAt: string } | null;
}

const SOURCE_AR: Record<string, string> = { AGENT: "سجّلها موظف", CUSTOMER_KEYWORD: "الزبون كتب «إيقاف»" };
const CHANNEL_AR: Record<string, string> = { whatsapp: "واتساب", messenger: "ماسنجر", instagram: "إنستغرام", telegram: "تيليغرام", tiktok: "تيك توك", web: "الموقع" };

/**
 * P12 — موافقة الزبون على الرسائل التسويقية + مصدره (إعلان · رمز كليبر).
 * الحملات (عندنا أو من الكليبر وHermes) بتطلع للموافقين بس — والموافقة
 * ما بتنستنتج من الكلام: الموظف بيسجّلها بعد ما الزبون يوافق صراحة.
 */
export function MarketingCard({ customerId }: { customerId: string }) {
  const toast = useToast();
  const [view, setView] = useState<MarketingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [reopt, setReopt] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await apiJson<MarketingView>(`/api/customers/${customerId}/consent`));
    } catch {
      setView(null);
    }
  }, [customerId]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  async function set(consent: "OPTED_IN" | "OPTED_OUT", reoptIn = false) {
    setBusy(true);
    try {
      const r = await apiJson<{ view: MarketingView }>(`/api/customers/${customerId}/consent`, { method: "POST", json: { consent, ...(reoptIn ? { reoptIn: true } : {}) } });
      setView(r.view);
      toast.show(consent === "OPTED_IN" ? "انسجّلت الموافقة على الرسائل" : "انلغى الاشتراك — ما بتوصله ولا حملة");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "فشل";
      if (/صريح|REOPT/i.test(msg)) setReopt(true);
      else toast.show(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!view) return null;
  const optedIn = view.consent === "OPTED_IN";
  const optedOut = view.consent === "OPTED_OUT" || Boolean(view.optOutAt);
  const a = view.attribution;
  return (
    <GlassCard level="glass-subtle" className="space-y-2.5 p-3.5 text-xs">
      <p className="flex items-center gap-1.5 font-bold text-ink">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
          <Megaphone size={13} />
        </span>
        الرسائل التسويقية
        <HealthPill health={optedIn ? "ok" : optedOut ? "error" : "off"}>{optedIn ? "موافق" : optedOut ? "ألغى" : "ما وافق لسا"}</HealthPill>
      </p>
      {(view.consentAt || view.optOutAt) && (
        <p className="text-[11px] text-ink-subtle">
          {optedOut ? `ألغى ${fmtDateTime(view.optOutAt)}` : `وافق ${fmtDateTime(view.consentAt)}`}
          {view.consentSource ? ` · ${SOURCE_AR[view.consentSource] ?? view.consentSource}` : ""}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {!optedIn && (
          <Button size="sm" variant="secondary" onClick={() => set("OPTED_IN")} disabled={busy}>
            <BellRing size={12} />
            وافق صراحة
          </Button>
        )}
        {!optedOut && (
          <Button size="sm" variant="ghost" onClick={() => set("OPTED_OUT")} disabled={busy}>
            <BellOff size={12} />
            ألغِ الاشتراك
          </Button>
        )}
      </div>
      {a && (
        <p className="border-t border-line/60 pt-2 text-[11px] leading-relaxed text-ink-muted">
          المصدر: {a.kind === "AD" ? "إعلان" : "رمز كليبر"} · {CHANNEL_AR[a.channel] ?? a.channel}
          {a.refCode ? (
            <>
              {" · "}
              <span dir="ltr" className="font-mono">{a.refCode}</span>
              {a.codeStatus === "INVALID" ? " (مرفوض)" : a.codeStatus === "VALID" ? " ✓" : ""}
            </>
          ) : null}
          {a.adId ? (
            <>
              {" · "}
              <span dir="ltr" className="font-mono">{a.adId}</span>
            </>
          ) : null}
          {" · "}
          {fmtDateTime(a.occurredAt)}
        </p>
      )}
      <ConfirmDialog
        open={reopt}
        onClose={() => setReopt(false)}
        onConfirm={() => {
          setReopt(false);
          void set("OPTED_IN", true);
        }}
        title="الزبون ألغى قبل — طلب صراحة يرجع؟"
        body="سجّل الرجوع بس إذا الزبون نفسه طلب يوصله عروض من جديد (بالمحادثة). غير هيك ممنوع نبعتله."
        confirmLabel="نعم، طلب صراحة"
        busy={busy}
      />
    </GlassCard>
  );
}
