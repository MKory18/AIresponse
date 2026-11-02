-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "memoryResetAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "orderBatchId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "offerNameSnapshot" TEXT,
ADD COLUMN     "offerQuantity" INTEGER;

-- CreateIndex
CREATE INDEX "Order_workspaceId_orderBatchId_idx" ON "Order"("workspaceId", "orderBatchId");
