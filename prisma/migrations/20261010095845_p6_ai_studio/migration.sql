-- AlterTable
ALTER TABLE "AISettings" ADD COLUMN     "customBaseUrl" TEXT,
ADD COLUMN     "fallbackModel" TEXT,
ADD COLUMN     "fallbackProvider" TEXT;

-- AlterTable
ALTER TABLE "AIUsageLog" ADD COLUMN     "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "handoffReason" TEXT,
ADD COLUMN     "personaId" TEXT,
ADD COLUMN     "personaVersion" INTEGER,
ALTER COLUMN "costUsd" DROP NOT NULL,
ALTER COLUMN "costUsd" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Persona" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "PersonaVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "language" TEXT NOT NULL DEFAULT 'ar',
    "dialect" TEXT,
    "formality" TEXT NOT NULL DEFAULT 'informal',
    "emojiLevel" INTEGER NOT NULL DEFAULT 1,
    "responseLength" TEXT NOT NULL DEFAULT 'short',
    "salesStyle" TEXT NOT NULL DEFAULT 'helpful',
    "systemInstructions" TEXT,
    "prohibitedPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonaVersion_workspaceId_personaId_idx" ON "PersonaVersion"("workspaceId", "personaId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaVersion_personaId_version_key" ON "PersonaVersion"("personaId", "version");

-- AddForeignKey
ALTER TABLE "PersonaVersion" ADD CONSTRAINT "PersonaVersion_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
