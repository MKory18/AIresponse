import EmptySection, { enforcePermission } from "@/components/empty-section";

export default async function Page() {
  await enforcePermission("analytics.read");
  return <EmptySection title="التحليلات" description="تقارير الأداء والاستخدام — قيد البناء في المرحلة 8." permission="analytics.read" />;
}
