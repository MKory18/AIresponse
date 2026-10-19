-- مختبر التجميع — وضع «جمع فقط» لكل صفحة + جداول المعلومات المستخرجة.
-- ترحيل إضافي فقط: لا حذف ولا تغيير نوع لأي عمود قائم. القيمة الافتراضية
-- AUTO_REPLY تحافظ على سلوك كل الصفحات الحالية بلا أي تغيير.

CREATE TYPE "ChannelSendMode" AS ENUM ('AUTO_REPLY', 'COLLECTION_ONLY');
CREATE TYPE "IntelStatus" AS ENUM ('PENDING', 'READY', 'NEEDS_REVIEW', 'FAILED');

ALTER TABLE "Channel" ADD COLUMN "sendMode" "ChannelSendMode" NOT NULL DEFAULT 'AUTO_REPLY';

CREATE TABLE "CustomerIntel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "IntelStatus" NOT NULL DEFAULT 'PENDING',
    "data" JSONB NOT NULL DEFAULT '{}',
    "fieldMeta" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "extractedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerIntel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerIntel_conversationId_key" ON "CustomerIntel"("conversationId");
CREATE INDEX "CustomerIntel_workspaceId_status_idx" ON "CustomerIntel"("workspaceId", "status");
CREATE INDEX "CustomerIntel_channelId_idx" ON "CustomerIntel"("channelId");

CREATE TABLE "CustomerIntelRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "model" TEXT,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "CustomerIntelRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerIntelRun_messageId_key" ON "CustomerIntelRun"("messageId");
CREATE INDEX "CustomerIntelRun_workspaceId_queuedAt_idx" ON "CustomerIntelRun"("workspaceId", "queuedAt");
CREATE INDEX "CustomerIntelRun_conversationId_queuedAt_idx" ON "CustomerIntelRun"("conversationId", "queuedAt");

ALTER TABLE "CustomerIntel" ADD CONSTRAINT "CustomerIntel_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
