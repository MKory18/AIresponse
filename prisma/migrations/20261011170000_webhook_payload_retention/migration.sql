-- مدة الاحتفاظ بحمولة أحداث القنوات الخام.
-- إضافة فقط: عمود nullable + فهرس للكنس. ولا حذف ولا تغيير نوع.
-- الصف نفسه ما بينحذف أبدًا — عدم تكرار الأحداث معتمد على
-- (source, externalEventId)، فحذف الصف بيخلّي إعادة قديمة تنعالج من جديد.

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "payloadPurgedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "WebhookEvent_payloadPurgedAt_createdAt_idx" ON "WebhookEvent"("payloadPurgedAt", "createdAt");
