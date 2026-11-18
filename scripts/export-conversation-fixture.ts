/**
 * تصدير محادثة كملف مرجعي للاختبارات (الحزمة 0.4) — قراءة فقط من القاعدة، وبتبدّل قبل الكتابة.
 *
 *   node --import tsx scripts/export-conversation-fixture.ts <conversationId> <اسم-الملف> [اسم عَلَم إضافي ...]
 *
 * بيكتب `tests/fixtures/conversations/<اسم-الملف>.json`. أرقام الهواتف بتتبدّل برقم وهمي بنفس
 * الصيغة، وأسماء العميل والموظفين (من القاعدة) + الأسماء الممرّرة بتتبدّل بأسماء وهمية ثابتة.
 * إذا باقي أي رقم أو اسم أصلي بالمخرجات السكربت بيفشل وما بيكتب شي.
 * ⚠️ لا ترفع الملف قبل ما تقرأه بعينك (عناوين وأسماء شوارع ممكن تدل على شخص). اكتب `<اسم>.expected.json` بإيدك.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { toWesternDigits } from "../src/modules/orders/primitives";
import { anonymizeConversation, assertAnonymized, type FixtureMessage } from "../src/modules/orders/reader/fixture-export";

async function main() {
  const [conversationId, fileName, ...extraNames] = process.argv.slice(2);
  if (!conversationId || !fileName) throw new Error("usage: export-conversation-fixture.ts <conversationId> <file-name> [name ...]");
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/i.test(fileName)) throw new Error("file-name: حروف وأرقام وشرطات بس");
  const prisma = new PrismaClient();
  try {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new Error("CONVERSATION_NOT_FOUND");
    const channel = await prisma.channel.findUnique({ where: { id: conv.channelId }, select: { displayName: true, market: true } });
    const customer = await prisma.customer.findUnique({ where: { id: conv.customerId }, select: { name: true, phone: true } });
    const rows = await prisma.message.findMany({
      where: { conversationId, deletedAt: null, isNote: false },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { senderType: true, type: true, text: true, createdAt: true, senderId: true },
    });
    const staffIds = [...new Set(rows.map((r) => r.senderId).filter((v): v is string => Boolean(v)))];
    const staff = staffIds.length ? await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { name: true } }) : [];
    const realNames = [customer?.name ?? "", ...staff.map((s) => s.name ?? ""), ...extraNames].filter(Boolean);
    const messages: FixtureMessage[] = rows.map((r, i) => ({
      id: `msg-${i + 1}`,
      senderType: r.senderType as FixtureMessage["senderType"],
      type: r.type,
      text: r.text,
      createdAt: r.createdAt.toISOString(),
    }));
    const anon = anonymizeConversation(messages, realNames);
    const body = {
      note: "محادثة مرجعية بدّلنا فيها الأرقام والأسماء (0.4). راجعها بعينك قبل الرفع.",
      page: channel?.displayName ?? "الصفحة",
      market: channel?.market ?? null,
      messages: anon.messages,
    };
    const serialized = JSON.stringify(body, null, 2);
    const realPhones = [
      ...anon.phones.map((p) => p.real),
      ...(customer?.phone ? [toWesternDigits(customer.phone).replace(/\D/g, "")] : []),
    ];
    assertAnonymized(serialized, realPhones, realNames);
    const dir = "tests/fixtures/conversations";
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/${fileName}.json`;
    writeFileSync(path, `${serialized}\n`, "utf8");
    console.log(`تم: ${path} — ${anon.messages.length} رسالة · ${anon.phones.length} رقم و${anon.names.length} اسم اتبدّلوا`);
    const expected = `${dir}/${fileName}.expected.json`;
    if (!existsSync(expected)) console.log(`اكتب القراءة الصح بإيدك: ${expected}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
