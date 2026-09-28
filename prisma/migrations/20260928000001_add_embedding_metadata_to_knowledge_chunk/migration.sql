-- Add embedding provider/model/dimensions tracking to KnowledgeChunk.
-- These columns enable safe embedding configuration changes by tracking
-- which provider/model generated each vector. Search filters by these
-- fields to prevent mixing incompatible embedding generations.

ALTER TABLE "KnowledgeChunk" ADD COLUMN "embeddingProvider" TEXT;
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embeddingDimensions" INTEGER;

-- Index for efficient filtering by embedding generation
CREATE INDEX "KnowledgeChunk_embedding_idx" ON "KnowledgeChunk" ("workspaceId", "embeddingProvider", "embeddingModel", "embeddingDimensions");