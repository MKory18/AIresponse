-- CreateEnum
CREATE TYPE "DiscountApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "SalesEventType" AS ENUM ('OFFER_QUALIFIED', 'OFFER_SHOWN', 'OFFER_ACCEPTED', 'CROSS_SELL_SHOWN', 'CROSS_SELL_ADDED', 'COACH_USED', 'DISCOUNT_REQUESTED', 'DISCOUNT_APPROVED', 'DISCOUNT_REJECTED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "adSource" TEXT,
ADD COLUMN     "adSourceAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DiscountApproval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "orderId" TEXT,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "unitPriceAtApproval" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "discountAmount" DECIMAL(12,2),
    "reason" TEXT,
    "status" "DiscountApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "SalesEventType" NOT NULL,
    "conversationId" TEXT,
    "customerId" TEXT,
    "orderId" TEXT,
    "productId" TEXT,
    "sku" TEXT,
    "value" DOUBLE PRECISION,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscountApproval_workspaceId_status_idx" ON "DiscountApproval"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "DiscountApproval_workspaceId_createdAt_idx" ON "DiscountApproval"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesEvent_workspaceId_type_createdAt_idx" ON "SalesEvent"("workspaceId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "SalesEvent_conversationId_idx" ON "SalesEvent"("conversationId");
