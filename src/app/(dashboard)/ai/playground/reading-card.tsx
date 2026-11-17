"use client";

import { useState } from "react";
import { ScanSearch } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import type { VerifiedReading } from "@/modules/orders/reader/verify";

type Result = { decision: { read: boolean; reason: string }; reading: VerifiedReading | null };

const STAGE: Record<string, string> = {
  NONE: "ما في طلب",
  INTERESTED: "العميل مهتم",
  COLLECTING: "بنجمّع بيانات الطلب",
  COMPLETE: "الطلب مكتمل",
  CANCELLED: "العميل ألغى",
};
const MISSING: Record<string, string> = { product: "المنتج", quantity: "الكمية", phone: "الهاتف", address: "العنوان", name: "الاسم" };

/**
 * «شو قرأ النظام» (3.5): القارئ على محادثة التجربة — بيعرض بطاقة الطلب اللي كانت رح تطلع، **بلا ما ينشأ أي طلب**.
 */
export function ReadingCard({ sessionId, hasMessages }: { sessionId: string | null; hasMessages: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<Result>(`/api/ai/playground/sessions/${sessionId}/reading`, { method: "POST" }));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "تعذّرت القراءة");
    } finally {
      setBusy(false);
    }
  }

  const r = result?.reading ?? null;
  return (
    <div className="border-t border-line/60 px-3 py-2 sm:px-5" data-playground-reading>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => void run()} loading={busy} disabled={busy || !sessionId || !hasMessages}>
          <ScanSearch size={14} aria-hidden /> شو قرأ النظام
        </Button>
        <span className="text-[11px] text-ink-muted">بيقرأ المحادثة كأنها حقيقية، بدون ما ينشئ أي طلب.</span>
      </div>
      {error && <p role="alert" className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}
      {result && !r && <p className="mt-2 text-xs text-ink-muted">المحادثة ما فيها شي شبه طلب (لا منتج ولا رقم)، فالنظام ما كان رح يقرأها.</p>}
      {r && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-2" data-playground-reading-card>
          <div><dt className="font-bold text-ink">الحالة</dt><dd className="text-ink-muted">{STAGE[r.stage] ?? r.stage}</dd></div>
          <div>
            <dt className="font-bold text-ink">المنتجات</dt>
            <dd className="text-ink-muted">
              {r.items.length === 0 ? "—" : r.items.map((i) => `${i.name} × ${i.quantity ?? "؟"}`).join("، ")}
              {r.unresolved.length > 0 && ` · غير محسوم: ${r.unresolved.map((u) => u.ref).join("، ")}`}
            </dd>
          </div>
          <div><dt className="font-bold text-ink">العميل</dt><dd className="text-ink-muted">{r.recipient.name ?? "—"} · <span dir="ltr">{r.recipient.phone ?? "—"}</span></dd></div>
          <div><dt className="font-bold text-ink">العنوان</dt><dd className="text-ink-muted">{[r.recipient.province ?? r.recipient.city, r.recipient.address].filter(Boolean).join(" — ") || "—"}</dd></div>
          <div><dt className="font-bold text-ink">الإجمالي</dt><dd className="text-ink-muted">{r.totals.total} {r.totals.currency ?? ""}</dd></div>
          <div><dt className="font-bold text-ink">الموافقة</dt><dd className="text-ink-muted">{r.agreement.state === "EXPLICIT" ? "صريحة" : r.agreement.state === "IMPLICIT" ? "ضمنية" : "ما في"}</dd></div>
          {r.missing.length > 0 && <div className="sm:col-span-2"><dt className="font-bold text-ink">ناقص</dt><dd className="text-amber-700 dark:text-amber-300">{r.missing.map((m) => MISSING[m] ?? m).join("، ")}</dd></div>}
          {r.needsHuman?.value && <div className="sm:col-span-2"><dt className="font-bold text-ink">بيحتاج موظف</dt><dd className="text-red-600 dark:text-red-400">{r.needsHuman.reason ?? "—"}</dd></div>}
        </dl>
      )}
    </div>
  );
}
