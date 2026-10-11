-- P12 — الربط مع منظومة Zaki (الـ OMS · الميديا باير · الكليبر · المالية ·
-- سيستم 1 · الأزمات · المهام · مساحة العمل) وباب الوكلاء (Hermes).
-- إضافات فقط: لا حذف ولا تغيير نوع لأي عمود موجود. الصفوف القديمة في
-- OmsConnection تبقى mode=api و apiVersion=legacy (سلوكها لا يتغير).

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "integrationSettings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "market" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "marketingConsentSource" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "s1ProductRef" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "adId" TEXT,
ADD COLUMN     "adSourceType" TEXT,
ADD COLUMN     "attributionMethod" TEXT,
ADD COLUMN     "channel" TEXT,
ADD COLUMN     "ctwaClidEnc" TEXT,
ADD COLUMN     "handoffMode" TEXT,
ADD COLUMN     "omsOrderNumber" TEXT,
ADD COLUMN     "pageRef" TEXT,
ADD COLUMN     "psidEnc" TEXT,
ADD COLUMN     "refCode" TEXT,
ADD COLUMN     "refCodeAt" TIMESTAMP(3),
ADD COLUMN     "touchAt" TIMESTAMP(3),
ADD COLUMN     "wabaId" TEXT;

-- AlterTable
ALTER TABLE "OmsConnection" ADD COLUMN     "apiVersion" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "autoHandoff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastOkAt" TIMESTAMP(3),
ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'api',
ADD COLUMN     "webhookKey" TEXT,
ADD COLUMN     "webhookSecretEncrypted" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "externalIdempotencyKey" TEXT,
ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "externalSystem" TEXT,
ADD COLUMN     "finalResultsSentAt" TIMESTAMP(3),
ADD COLUMN     "resultsSentAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "AttributionTouch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "adId" TEXT,
    "adSourceType" TEXT,
    "ctwaClidEnc" TEXT,
    "refCode" TEXT,
    "codeStatus" TEXT,
    "codeProductCode" TEXT,
    "codeCampaignRef" TEXT,
    "codeWindowDays" INTEGER,
    "pageId" TEXT,
    "psidEnc" TEXT,
    "wabaId" TEXT,
    "messageId" TEXT,
    "episodeStart" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "baseUrl" TEXT,
    "tokenEncrypted" TEXT,
    "eventsUrl" TEXT,
    "eventsSecretEncrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lastOkAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rateLimitPerMin" INTEGER NOT NULL DEFAULT 60,
    "dailyDraftCap" INTEGER NOT NULL DEFAULT 20,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationDelivery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventId" TEXT,
    "type" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "url" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "responseCode" INTEGER,
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenId" TEXT,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "resultRef" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCallLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenId" TEXT,
    "tool" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "requestId" TEXT,
    "agentRef" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCompliance" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productRef" TEXT NOT NULL,
    "classification" TEXT,
    "verdict" TEXT,
    "allowedClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bannedClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "adRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceUpdatedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCompliance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_workspaceId_omsOrderNumber_idx" ON "Order"("workspaceId", "omsOrderNumber");

-- CreateIndex
CREATE INDEX "Order_workspaceId_refCode_idx" ON "Order"("workspaceId", "refCode");

-- CreateIndex
CREATE UNIQUE INDEX "OmsConnection_webhookKey_key" ON "OmsConnection"("webhookKey");

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_externalSystem_externalRef_idx" ON "Campaign"("workspaceId", "externalSystem", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workspaceId_externalIdempotencyKey_key" ON "Campaign"("workspaceId", "externalIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AttributionTouch_dedupeKey_key" ON "AttributionTouch"("dedupeKey");

-- CreateIndex
CREATE INDEX "AttributionTouch_workspaceId_conversationId_occurredAt_idx" ON "AttributionTouch"("workspaceId", "conversationId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttributionTouch_workspaceId_customerId_occurredAt_idx" ON "AttributionTouch"("workspaceId", "customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttributionTouch_workspaceId_refCode_idx" ON "AttributionTouch"("workspaceId", "refCode");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_workspaceId_system_key" ON "IntegrationConnection"("workspaceId", "system");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationToken_tokenHash_key" ON "IntegrationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "IntegrationToken_workspaceId_system_idx" ON "IntegrationToken"("workspaceId", "system");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationDelivery_dedupeKey_key" ON "IntegrationDelivery"("dedupeKey");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_status_nextAttemptAt_idx" ON "IntegrationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_workspaceId_system_createdAt_idx" ON "IntegrationDelivery"("workspaceId", "system", "createdAt");

-- CreateIndex
CREATE INDEX "AgentDraft_workspaceId_status_createdAt_idx" ON "AgentDraft"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentDraft_tokenId_createdAt_idx" ON "AgentDraft"("tokenId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDraft_workspaceId_idempotencyKey_key" ON "AgentDraft"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentCallLog_workspaceId_createdAt_idx" ON "AgentCallLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCallLog_tokenId_createdAt_idx" ON "AgentCallLog"("tokenId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCompliance_productId_key" ON "ProductCompliance"("productId");

-- CreateIndex
CREATE INDEX "ProductCompliance_workspaceId_idx" ON "ProductCompliance"("workspaceId");

-- AddForeignKey
ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationToken" ADD CONSTRAINT "IntegrationToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDraft" ADD CONSTRAINT "AgentDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCallLog" ADD CONSTRAINT "AgentCallLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCompliance" ADD CONSTRAINT "ProductCompliance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCompliance" ADD CONSTRAINT "ProductCompliance_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
