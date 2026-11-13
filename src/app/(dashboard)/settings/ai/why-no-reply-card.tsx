"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GlassCard } from "@/components/ui/card";
import { RiskNote, FixNote } from "@/components/integrations/ui";

/**
 * «ليش ما رد؟» — الأسباب الفعلية لفشل الردود بالأرقام.
 *
 * ⚠️ قبل: لما الوكيل يبطّئ أو يسكت، ما في ولا شاشة بتقول ليش. الرقم الوحيد
 * كان بـ `/api/health` (مهام فاشلة: ٣٤٨٢) وهاد بلا سبب ما بيدلّ على شي.
 * 🔧 هلأ: أكتر أسباب الفشل تكرارًا، من `GET /api/analytics/queue`، بلا أي
 * بيانات زبون (الأرقام والمعرّفات بتنشال من نص السبب قبل ما يطلع).
 */

type Failure = { type: string; reason: string; count: number; lastAt: string | null };
type QueueData = {
  pending: number;
  running: number;
  failed: number;
  topFailures?: Failure[];
};

const JOB_AR: Record<string, string> = {
  process_ai_message: "توليد رد على رسالة زبون",
  process_channel_inbound: "استقبال رسالة من القناة",
  process_webhook_event: "استقبال حدث من القناة",
  notify_order_telegram: "ترحيل طلب لتيليغرام",
  handoff_order_to_oms: "ترحيل طلب للـ OMS",
  sync_oms_products: "مزامنة منتجات الـ OMS",
  extract_customer_intel: "استخراج بيانات الزبون",
  download_whatsapp_media: "تنزيل وسائط واتساب",
};

function jobLabel(type: string): string {
  return JOB_AR[type] ?? type;
}

/** شرح بالعربي لأشهر أسباب الفشل، مع التصحيح. */
function explain(reason: string): { what: string; fix: string } | null {
  const r = reason.toLowerCase();
  if (r.includes("guardrail")) {
    return {
      what: "الحارس رفض الرد مرتين — الموديل كتب سعرًا أو ادعاءً مش مسموح.",
      fix: "راجع سعر المنتج وقواعد سيستم ١: السعر الرسمي لازم يكون مكتوب بالمنتج.",
    };
  }
  if (r.includes("timeout") || r.includes("timed out")) {
    return { what: "مزوّد الذكاء تأخر وما رد بالوقت.", fix: "جرّب نموذج أسرع من إعدادات الذكاء، أو زوّد مهلة المزوّد." };
  }
  if (r.includes("429") || r.includes("rate")) {
    return { what: "مزوّد الذكاء رفض الطلبات — تجاوزت الحد المسموح.", fix: "نموذج مدفوع أو مفتاح بحد أعلى من إعدادات الذكاء." };
  }
  if (r.includes("401") || r.includes("403") || r.includes("api key") || r.includes("unauthorized")) {
    return { what: "مفتاح مزوّد الذكاء مرفوض أو منتهي.", fix: "جدّد المفتاح من إعدادات الذكاء واضغط «اختبر الاتصال»." };
  }
  if (r.includes("window_closed") || r.includes("policy_")) {
    return { what: "القناة رفضت الإرسال — مرّ أكتر من ٢٤ ساعة على آخر رسالة من الزبون.", fix: "قاعدة من ميتا، ما منقدر نتجاوزها — الزبون لازم يكتب أول." };
  }
  if (r.includes("token_expired") || r.includes("token_invalid") || r.includes("token_decrypt")) {
    return { what: "توكن الصفحة منتهي — القناة مش موصولة.", fix: "أعد ربط الصفحة من «القنوات»." };
  }
  if (r.includes("outbound delivery")) {
    return { what: "الرد انكتب بس ما طلع للزبون.", fix: "افحص حالة القناة من «القنوات»." };
  }
  return null;
}

export function WhyNoReplyCard() {
  const [data, setData] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/analytics/queue", { cache: "no-store" });
      const json = await res.json();
      setData((json?.data ?? json) as QueueData);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const failures = data?.topFailures ?? [];

  return (
    <GlassCard className="p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">ليش ما رد؟</h2>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="size-4 ms-1" />
          تحديث
        </Button>
      </div>

      {loading && !data ? (
        <Skeleton className="h-20 w-full" />
      ) : !data ? (
        <p className="text-sm text-muted-foreground">ما قدرنا نقرأ حالة الطابور هلأ.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              بالانتظار: <strong>{data.pending}</strong>
            </span>
            <span>
              عم تشتغل: <strong>{data.running}</strong>
            </span>
            <span>
              فشلت: <strong>{data.failed}</strong>
            </span>
          </div>

          {failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              ما في فشل مسجّل. إذا في رسالة بلا رد، افتح المحادثة وشوف آخر رسالة وصلت.
            </p>
          ) : (
            <ul className="space-y-3">
              {failures.map((f) => {
                const note = explain(f.reason);
                return (
                  <li key={`${f.type}|${f.reason}`} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{jobLabel(f.type)}</span>
                      <span className="text-xs text-muted-foreground">{f.count} مرة</span>
                    </div>
                    {note ? (
                      <>
                        <RiskNote title={note.what} />
                        <FixNote>{note.fix}</FixNote>
                      </>
                    ) : (
                      <RiskNote title={f.reason} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </GlassCard>
  );
}
