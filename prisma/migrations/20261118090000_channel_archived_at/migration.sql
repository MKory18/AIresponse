-- Additive only: a stopped page is hidden from the list, never deleted.
-- Deleting a Channel row cascades to Conversation (and its history), so the
-- "remove page" action marks this column instead.
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
