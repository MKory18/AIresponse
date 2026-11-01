/**
 * عدّ صفوف الجداول الأساسية — يُستخدم للتحقق من نسخة احتياطية مسترجعة.
 *
 *   node --import tsx scripts/db-counts.ts
 *   $env:DATABASE_URL="postgresql://…/ai_commerce_restore"; node --import tsx scripts/db-counts.ts
 *
 * يطبع JSON بترتيب ثابت؛ قارن مخرَجي المصدر والمسترجَع — أي فرق = استرجاع ناقص.
 */
import { PrismaClient } from "@prisma/client";

const TABLES = [
  "workspace",
  "user",
  "workspaceMember",
  "customer",
  "conversation",
  "message",
  "product",
  "productVariant",
  "order",
  "orderItem",
  "orderDraft",
  "deliveryRule",
  "backgroundJob",
  "campaign",
  "campaignRecipient",
  "followUp",
  "aIUsageLog",
  "webhookEvent",
  "integrationConnection",
  "integrationDelivery",
] as const;

async function main() {
  const prisma = new PrismaClient();
  const counts: Record<string, number> = {};
  try {
    for (const table of TABLES) {
      const model = (prisma as unknown as Record<string, { count?: () => Promise<number> }>)[table];
      counts[table] = typeof model?.count === "function" ? await model.count() : -1;
    }
  } finally {
    await prisma.$disconnect();
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(counts, null, 2));
}

void main();
