/**
 * تقرير وضع الظل لقارئ الطلب (قراءة فقط — ولا كتابة).
 *
 *   node --import tsx scripts/reader-shadow-report.ts <workspaceId> [أيام=3]
 *
 * بيقارن قراءات القارئ المحفوظة مع الطلبات اللي سجّلتها المسودة القديمة
 * بنفس المحادثات: متفقين · القارئ لقط وحده · المسودة سجّلت والقارئ فوّت (⚠️).
 * اكتب النتيجة للمالك قبل أي تفعيل (الحزمة 1.9).
 */
import { PrismaClient } from "@prisma/client";
import { summarizeShadow } from "../src/modules/orders/reader/report";

async function main() {
  const workspaceId = process.argv[2];
  if (!workspaceId) throw new Error("usage: reader-shadow-report.ts <workspaceId> [days]");
  const days = Math.max(1, Number(process.argv[3] ?? 3) || 3);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const prisma = new PrismaClient();
  try {
    const readings = await prisma.conversationReading.findMany({
      where: { workspaceId, updatedAt: { gte: since } },
      select: { conversationId: true, stage: true, status: true, flags: true, missing: true },
    });
    const orders = await prisma.order.findMany({
      where: { workspaceId, createdAt: { gte: since }, conversationId: { not: null }, status: { not: "CANCELLED" } },
      select: { conversationId: true },
    });
    const s = summarizeShadow(readings, orders.map((o) => o.conversationId as string));
    console.log(`آخر ${days} يوم · ${s.total} قراءة · ${s.failed} فاشلة`);
    console.log("المراحل:", Object.entries(s.byStage).map(([k, v]) => `${k}=${v}`).join(" · ") || "—");
    console.log(`القارئ كان رح يسجّل ${s.wouldCreate} طلب: متفق مع المسودة ${s.agreed} · القارئ لحاله ${s.readerOnly}`);
    console.log(`⚠️ المسودة سجّلت والقارئ فوّت: ${s.legacyOnly}`);
    for (const f of s.flags) console.log(`${String(f.count).padStart(4)} × ${f.flag}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
