-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "orderRequiredFields" TEXT[] DEFAULT ARRAY['product', 'quantity', 'phone', 'address']::TEXT[];

-- CreateTable
CREATE TABLE "TelegramOrderSettings" (
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "botTokenEnc" TEXT,
    "chatId" TEXT,
    "topicId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramOrderSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- AddForeignKey
ALTER TABLE "TelegramOrderSettings" ADD CONSTRAINT "TelegramOrderSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
