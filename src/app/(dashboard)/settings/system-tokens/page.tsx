import { PageHeader } from "@/components/ui/card";
import { SystemTokensView } from "./system-tokens-view";

/**
 * «الإعدادات › توكنات الأنظمة»: التوكنات اللي بتدخل فيها أنظمة المنظومة (الميديا باير · الكليبر) على الموقع.
 * بتنصنع من هون، والصلاحية `integrations.manage` (الخادم بيفرضها بكل مسار).
 */
export default function SystemTokensPage() {
  return (
    <div className="page-wrap">
      <PageHeader title="توكنات الأنظمة" description="مفاتيح دخول الأنظمة الثانية (الميديا باير · الكليبر) على الموقع. بتنصنع هون وبتظهر مرة وحدة بس." />
      <SystemTokensView />
    </div>
  );
}
