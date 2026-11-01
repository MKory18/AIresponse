-- المرحلة ٣ (تشغيلي) — جدول نبضة العامل لفحص الصحة.
-- ترحيل إضافي فقط: جدول جديد — لا حذف ولا تغيير بيانات قائمة.

CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "lastCycleAt" TIMESTAMP(3) NOT NULL,
    "cycles" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerHeartbeat_workerId_key" ON "WorkerHeartbeat"("workerId");
CREATE INDEX "WorkerHeartbeat_lastCycleAt_idx" ON "WorkerHeartbeat"("lastCycleAt");
