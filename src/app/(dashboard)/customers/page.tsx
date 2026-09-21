import EmptySection, { enforcePermission } from "@/components/empty-section";

export default async function Page() {
  await enforcePermission("customers.read");
  return <EmptySection title="العملاء" description="ملفات العملاء والذاكرة وسجل الطلبات — قيد البناء في المرحلة 2." permission="customers.read" />;
}
