-- AlterEnum
ALTER TYPE "HandoffReason" ADD VALUE 'ORDER_CHANGE_REQUEST';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "agreement" TEXT,
ADD COLUMN     "heldBy" TEXT,
ADD COLUMN     "omsCheckedAt" TIMESTAMP(3),
ADD COLUMN     "omsShippingStatus" TEXT,
ADD COLUMN     "readVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recipientAltPhone" TEXT,
ADD COLUMN     "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sealedAt" TIMESTAMP(3),
ADD COLUMN     "settleAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DeliveryRule" ADD COLUMN     "currency" TEXT;

-- CreateTable
CREATE TABLE "ConversationReading" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'NONE',
    "readThroughMessageId" TEXT,
    "readThroughAt" TIMESTAMP(3),
    "data" JSONB NOT NULL DEFAULT '{}',
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "orderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "readAt" TIMESTAMP(3),
    "firstInterestedAt" TIMESTAMP(3),
    "firstOrderingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRevision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "diff" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "actor" TEXT NOT NULL,
    "omsState" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationReading_conversationId_key" ON "ConversationReading"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationReading_workspaceId_stage_idx" ON "ConversationReading"("workspaceId", "stage");

-- CreateIndex
CREATE INDEX "ConversationReading_workspaceId_status_idx" ON "ConversationReading"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "OrderRevision_workspaceId_orderId_idx" ON "OrderRevision"("workspaceId", "orderId");

-- CreateIndex
CREATE INDEX "OrderRevision_workspaceId_omsState_idx" ON "OrderRevision"("workspaceId", "omsState");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRevision_orderId_version_key" ON "OrderRevision"("orderId", "version");

-- CreateIndex
CREATE INDEX "Order_workspaceId_status_settleAt_idx" ON "Order"("workspaceId", "status", "settleAt");

