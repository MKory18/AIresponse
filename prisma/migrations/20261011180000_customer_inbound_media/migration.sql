-- وسيط الزبون الوارد: تصنيف خاص + ربط بالرسالة.
-- إضافة فقط: قيمة enum جديدة + عمود nullable + فهرس.
-- ولا حذف ولا تغيير نوع — الصفوف القديمة تبقى على تصنيفها.

-- AlterEnum
ALTER TYPE "MediaCategory" ADD VALUE 'CUSTOMER_INBOUND';

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "messageId" TEXT;

-- CreateIndex
CREATE INDEX "MediaAsset_messageId_idx" ON "MediaAsset"("messageId");
