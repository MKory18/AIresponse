-- Phase 3 — قياس زمن الرد الحقيقي على جدول الرسائل.
-- ترحيل إضافي فقط: عمودان اختياريان + فهرس — لا حذف ولا تغيير نوع لبيانات قائمة.
-- الصفوف القديمة تبقى NULL (زمن غير معروف) — لا قيمة مُخترعة.

ALTER TABLE "Message" ADD COLUMN "respondedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "replyLatencyMs" INTEGER;

CREATE INDEX "Message_workspaceId_respondedAt_idx" ON "Message"("workspaceId", "respondedAt");
