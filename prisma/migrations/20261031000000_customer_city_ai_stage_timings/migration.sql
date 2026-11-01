-- P13 — (١) حقل «المدينة» على العميل (منفصل عن المحافظة)، (٢) تفصيل زمن
-- مراحل خط أنابيب الذكاء على سجل الاستخدام.
-- إضافي فقط: لا حذف ولا تغيير نوع، والصفوف القديمة تبقى NULL.

ALTER TABLE "Customer" ADD COLUMN "city" TEXT;

ALTER TABLE "AIUsageLog" ADD COLUMN "stageTimings" JSONB;
