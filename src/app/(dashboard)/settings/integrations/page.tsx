"use client";

import { PageHeader } from "@/components/ui/card";
import { MetaLoginSection } from "@/components/integrations/meta-login-section";
import { OmsSection } from "@/components/integrations/oms-section";
import { TelegramOrderSection } from "@/components/integrations/telegram-order-section";

/**
 * «الإعدادات › الربط» (3.6): ربط الـ OMS وتيليجرام الطلبات بصفحة وحدة — كانوا بصفحة القنوات.
 * أعطال الربط (شريط العطل · «يحتاجك») بتودّي لهون. الصلاحية `integrations.manage` (الخادم بيفرضها بكل مسار).
 */
export default function IntegrationsPage() {
  return (
    <div className="page-wrap">
      <PageHeader title="الربط" description="ربط ميتا والـ OMS وتيليجرام الطلبات. إذا في عطل بيظهر هون مع طريقة الإصلاح." />
      <MetaLoginSection />
      <OmsSection />
      <TelegramOrderSection />
    </div>
  );
}
