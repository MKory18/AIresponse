-- AlterTable
ALTER TABLE "KnowledgeDocument" ADD COLUMN "productId" TEXT;

-- CreateIndex
CREATE INDEX "KnowledgeDocument_workspaceId_productId_idx" ON "KnowledgeDocument"("workspaceId", "productId");

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
