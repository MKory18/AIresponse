/**
 * تقرير نداءات الذكاء الفاشلة آخر N يوم (قراءة فقط — ولا كتابة).
 *
 *   node --import tsx scripts/ai-failures-report.ts [أيام=7]
 *
 * بيجمّع `AIUsageLog` الفاشلة حسب الغرض والمزوّد والخطأ. اكتب النتيجة
 * للمالك قبل أي تصليح (الحزمة 0.3).
 */
import { PrismaClient } from "@prisma/client";
import { summarizeFailures } from "../src/modules/ai/failures-report";

async function main() {
  const days = Math.max(1, Number(process.argv[2] ?? 7) || 7);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.aIUsageLog.findMany({
      where: { createdAt: { gte: since } },
      select: { purpose: true, provider: true, success: true, status: true, error: true, latencyMs: true },
    });
    const s = summarizeFailures(rows);
    console.log(`آخر ${days} يوم: ${s.total} نداء · ${s.failed} فاشل (${s.failureRate}%)`);
    for (const g of s.groups) {
      console.log(`${String(g.count).padStart(4)} × ${g.purpose} · ${g.provider} · ${g.avgLatencyMs}ms · ${g.error}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
