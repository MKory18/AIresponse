-- Page-level AI persona assignment + customer avatar URLs.
-- All nullable, non-destructive: existing rows unaffected.
ALTER TABLE "Channel" ADD COLUMN "aiPersonaId" TEXT REFERENCES "Persona"("id") ON DELETE SET NULL;
ALTER TABLE "Customer" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "ChannelIdentity" ADD COLUMN "avatarUrl" TEXT;
