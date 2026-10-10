-- DropForeignKey
ALTER TABLE "Channel" DROP CONSTRAINT "Channel_aiPersonaId_fkey";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "omsStatusAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_aiPersonaId_fkey" FOREIGN KEY ("aiPersonaId") REFERENCES "Persona"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "KnowledgeChunk_embedding_idx" RENAME TO "KnowledgeChunk_workspaceId_embeddingProvider_embeddingModel_idx";
