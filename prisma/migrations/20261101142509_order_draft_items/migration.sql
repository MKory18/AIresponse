-- AlterTable
ALTER TABLE "OrderDraft" ADD COLUMN     "items" JSONB NOT NULL DEFAULT '[]';
