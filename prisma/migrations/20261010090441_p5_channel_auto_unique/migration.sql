-- P5 gate fix: concurrent first-contact webhooks both saw "no channel row"
-- and both created an auto channel, because @@unique(workspaceId, type,
-- externalId) never fires for NULL externalId (NULLs are distinct).
-- This partial unique index makes the second creator lose with P2002, and
-- ensureChannelId() re-reads the winner instead of 500ing.
-- Proven safe: zero duplicate (workspaceId, type, NULL) rows on dev before apply.
CREATE UNIQUE INDEX "Channel_workspace_type_null_external_idx"
  ON "Channel"("workspaceId", "type")
  WHERE "externalId" IS NULL;
