"use client";

import { PageHeader } from "@/components/ui/card";
import { OrderRulesCard } from "../../settings/ai/order-rules-card";

/**
 * «الوكيل الذكي › قواعد الطلب» (3.5): كيف بيقرأ الوكيل الطلب من المحادثة ومتى بيتثبّت (الوضع · مهلة التثبيت · التثبيت التلقائي
 * · الموافقة · رسالة التأكيد) + معيار القطع بالأرقام. نفس البطاقة الموجودة بصفحة التشغيل (بدون نسخ) — تغيير **الوضع** للمالك فقط.
 */
export default function OrderRulesPage() {
  return (
    <div className="page-wrap">
      <PageHeader title="قواعد الطلب" description="كيف بيقرأ الوكيل الطلب من المحادثة ومتى بيتثبّت. تغيير الوضع قرار المالك." />
      <OrderRulesCard />
    </div>
  );
}
