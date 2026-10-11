"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { FixNote, HealthPill, InfoNote, RiskNote, SectionHead, apiJson, fmtDateTime } from "@/components/integrations/ui";

interface ComplianceView {
  productRef: string;
  classification: string | null;
  verdict: string | null;
  allowedClaims: string[];
  bannedClaims: string[];
  adRules: string[];
  sourceUpdatedAt: string | null;
  fetchedAt: string | null;
  lastError: string | null;
  stale: boolean;
}

const VERDICT_AR: Record<string, string> = { pass: "مسموح", warn: "بتحفّظ", fail: "ممنوع", review: "قيد المراجعة" };

/**
 * P12 — قواعد الادعاءات من سيستم 1 لهالمنتج: المسموح والممنوع. الذكاء
 * والقوالب ما بيكتبوا ادعاء ممنوع أبدًا (الحارس بيرفض الرد قبل ما يطلع).
 */
export function ComplianceCard({ productId }: { productId: string }) {
  const toast = useToast();
  const [ref, setRef] = useState("");
  const [data, setData] = useState<{ s1ProductRef: string | null; compliance: ComplianceView | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiJson<{ s1ProductRef: string | null; compliance: ComplianceView | null }>(`/api/products/${productId}/compliance`);
      setData(r);
      setRef(r.s1ProductRef ?? "");
    } catch {
      setData({ s1ProductRef: null, compliance: null });
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setRefreshError(null);
    try {
      const r = await apiJson<{ s1ProductRef: string | null; compliance: ComplianceView | null; refreshError?: string | null }>(`/api/products/${productId}/compliance`, {
        method: "POST",
        json: body,
      });
      setData(r);
      setRef(r.s1ProductRef ?? "");
      if (r.refreshError) setRefreshError(r.refreshError);
      else toast.show("انقرأت القواعد من سيستم 1");
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "فشل", "error");
    } finally {
      setBusy(false);
    }
  }

  const c = data?.compliance ?? null;
  return (
    <GlassCard className="space-y-4 p-4 sm:p-5 xl:col-span-2">
      <SectionHead
        icon={<ShieldCheck size={15} />}
        title="الامتثال — قواعد سيستم 1"
        sub="المرجع من سيستم 1 لهالمنتج — القواعد بتتحدّث لحالها مع كل تعديل هناك، وكل أسبوع على الأقل."
        tone="emerald"
        action={c ? <HealthPill health={c.stale ? "warn" : c.verdict === "fail" ? "error" : "ok"}>{c.stale ? "نسخة قديمة" : VERDICT_AR[c.verdict ?? ""] ?? "محدّثة"}</HealthPill> : undefined}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="مرجع المنتج بسيستم 1" className="flex-1" hint="مثلًا pf_TIN01 — فاضي = المنتج مش مربوط">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} dir="ltr" className="num" maxLength={64} />
        </Field>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => post({ s1ProductRef: ref.trim() || null })} loading={busy} disabled={busy}>
            <Save size={13} />
            حفظ وقراءة
          </Button>
          {data?.s1ProductRef && (
            <Button size="sm" variant="secondary" onClick={() => post({ refresh: true })} disabled={busy}>
              <RefreshCw size={13} />
              اقرأ الآن
            </Button>
          )}
        </div>
      </div>

      {refreshError && (
        <div className="space-y-1.5">
          <RiskNote title={`ما انقرأت القواعد (${refreshError})`}>النسخة السابقة (إذا موجودة) بتضل شغّالة.</RiskNote>
          <FixNote>تأكد إن سيستم 1 مربوط بصفحة «الربط مع الأنظمة» وإن المرجع صحيح، وبعدين «اقرأ الآن».</FixNote>
        </div>
      )}

      {!data?.s1ProductRef ? (
        <div className="space-y-1.5">
          <RiskNote title="المنتج مش مربوط بسيستم 1 — ما في قائمة ادعاءات ممنوعة خاصة فيه" />
          <FixNote>حط مرجعه فوق: الذكاء وقوالب Hermes بيلتزموا بقواعده حرفيًا (الحارس العام بيضل شغّال بكل الأحوال).</FixNote>
        </div>
      ) : !c ? (
        <InfoNote>لسا ما في نسخة قواعد — «اقرأ الآن».</InfoNote>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
            <p className="mb-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300">مسموح نقول</p>
            {c.allowedClaims.length === 0 ? (
              <p className="text-[11px] text-ink-subtle">—</p>
            ) : (
              <ul className="list-inside list-disc space-y-0.5 text-xs text-ink">
                {c.allowedClaims.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-xl border border-red-500/25 bg-red-500/[0.05] p-3">
            <p className="mb-1.5 text-xs font-bold text-red-700 dark:text-red-300">ممنوع نقول (الرد بينرفض إذا فيه)</p>
            {c.bannedClaims.length === 0 ? (
              <p className="text-[11px] text-ink-subtle">—</p>
            ) : (
              <ul className="list-inside list-disc space-y-0.5 text-xs text-ink">
                {c.bannedClaims.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </div>
          {c.adRules.length > 0 && (
            <div className="rounded-xl border border-line p-3 md:col-span-2">
              <p className="mb-1.5 text-xs font-bold text-ink">قواعد الإعلان</p>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-ink-muted">
                {c.adRules.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-ink-subtle md:col-span-2">
            التصنيف: {c.classification ?? "—"} · تحديث سيستم 1: {fmtDateTime(c.sourceUpdatedAt)} · آخر قراءة: {fmtDateTime(c.fetchedAt)}
            {c.lastError ? ` · آخر خطأ: ${c.lastError}` : ""}
          </p>
          {c.stale && (
            <div className="space-y-1.5 md:col-span-2">
              <RiskNote title="النسخة أقدم من أسبوع — ممكن تكون القواعد تغيّرت" />
              <FixNote>«اقرأ الآن»، أو تأكد إن سيستم 1 بيبعت compliance.updated لرابط الاستقبال.</FixNote>
            </div>
          )}
        </div>
      )}
    </GlassCard>
  );
}
