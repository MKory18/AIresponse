-- Isolated AI Playground sessions. Internal test chats only: no relations to
-- production Conversation/Customer/Message/Order tables by design.

-- CreateTable
CREATE TABLE "PlaygroundSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "personaId" TEXT,
    "channelId" TEXT,
    "productId" TEXT,
    "useKnowledge" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaygroundSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaygroundMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaygroundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlaygroundSession_workspaceId_updatedAt_idx" ON "PlaygroundSession"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "PlaygroundMessage_sessionId_createdAt_idx" ON "PlaygroundMessage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlaygroundMessage" ADD CONSTRAINT "PlaygroundMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PlaygroundSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
