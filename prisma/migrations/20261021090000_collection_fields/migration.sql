-- مختبر التجميع: البيانات المطلوب تجميعها لكل مساحة (حقول قياسية + حقول خاصة).
-- ترحيل إضافي فقط: جدول جديد ونوع enum جديد — لا حذف ولا تغيير نوع لبيانات قائمة.
-- غياب أي صف لمساحة = الإعداد الافتراضي بالكود (كل حقول الكتالوج مفعّلة).

CREATE TYPE "IntelFieldKind" AS ENUM ('TEXT', 'PHONE', 'NUMBER', 'LIST');

CREATE TABLE "CollectionFieldSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "IntelFieldKind" NOT NULL DEFAULT 'TEXT',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CollectionFieldSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CollectionFieldSetting_workspaceId_key_key" ON "CollectionFieldSetting"("workspaceId", "key");
CREATE INDEX "CollectionFieldSetting_workspaceId_idx" ON "CollectionFieldSetting"("workspaceId");

ALTER TABLE "CollectionFieldSetting" ADD CONSTRAINT "CollectionFieldSetting_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
