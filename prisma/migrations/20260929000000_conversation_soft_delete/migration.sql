-- Soft-delete for Conversation: hidden from inbox/polling, history preserved.
-- No data loss: new nullable columns only. Orders/messages/audit rows untouched.
ALTER TABLE "Conversation" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "deletedBy" TEXT;

CREATE INDEX "Conversation_workspaceId_deletedAt_idx" ON "Conversation"("workspaceId", "deletedAt");
