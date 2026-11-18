/**
 * إعادة تشغيل قارئ الطلب على محادثة حقيقية — بلا أي كتابة (الحزمة 1.3).
 *
 *   node --import tsx scripts/reader-replay.ts <workspaceId> <conversationId>
 *
 * بيطبع نتيجة الفلتر والقراءة المتحقق منها. النداء بيمرّ من بوابة الخصوصية
 * (الأرقام بتتعتّم قبل أي مزوّد خارجي) — نفس مسار الإنتاج بالضبط.
 * ⚠️ بيطبع بيانات الزبون محليًا بالـ terminal: لا تلصقه بأي أداة خارجية.
 */
import { PrismaClient } from "@prisma/client";
import { replayConversation } from "../src/modules/orders/reader/service";

async function main() {
  const [workspaceId, conversationId] = process.argv.slice(2);
  if (!workspaceId || !conversationId) throw new Error("usage: reader-replay.ts <workspaceId> <conversationId>");
  const prisma = new PrismaClient();
  try {
    const { decision, verified } = await replayConversation(prisma as never, workspaceId, conversationId);
    console.log("الفلتر:", JSON.stringify(decision));
    console.log(verified ? JSON.stringify(verified, null, 2) : "(ما انقرأت — الفلتر قرّر ما في شي يشبه الطلب)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
