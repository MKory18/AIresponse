import { type ActorContext, type Db } from "@/modules/customers/service";
import { NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";

/**
 * حذف «ذاكرة المحادثة» — اللي تعلّمه الذكاء من رسائل هذه المحادثة فقط.
 *
 * - الذاكرة مش مربوطة بالمحادثة بجدول، بل بمصدرها: `ai_extraction:<messageId>`.
 *   فالحذف يمرّ على رسائل المحادثة ويحذف سجلات الذاكرة اللي مصدرها واحد منها.
 * - ملخّص المحادثة (`Conversation.summary`) ينمسح كمان — وإلا الذكاء بيرجع
 *   يقرأ نفس الخلاصة بالرسالة الجاية.
 * - **ما** ينمسح: الرسائل نفسها، ذاكرة محادثات العميل التانية، طلباته، ملاحظات
 *   فريق العمل (`Customer.notes`)، ولا سجل التدقيق.
 * - العملية مسجّلة بالتدقيق (عدد السجلات فقط، بلا أي نص).
 */
export async function resetConversationMemory(
  db: Db,
  ctx: ActorContext,
  conversationId: string
): Promise<{ deleted: number }> {
  const conversation = (await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, workspaceId: true, customerId: true },
  })) as { id: string; workspaceId: string; customerId: string } | null;
  if (!conversation || conversation.workspaceId !== ctx.workspaceId) {
    throw new NotFoundError("Conversation");
  }

  const messages = (await db.message.findMany({
    where: { conversationId },
    select: { id: true },
  })) as Array<{ id: string }>;
  const sources = messages.map((m) => `ai_extraction:${m.id}`);

  const deleted = await db.customerMemory.deleteMany({
    where: {
      workspaceId: ctx.workspaceId,
      customerId: conversation.customerId,
      // بلا رسائل ما في ذاكرة مصدرها المحادثة — لا نحذف ذاكرة العميل كلها.
      ...(sources.length > 0 ? { source: { in: sources } } : { id: "__none__" }),
    },
  });

  await db.conversation.update({
    where: { id: conversationId },
    data: { summary: null },
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "conversation.memory_reset",
    entityType: "Conversation",
    entityId: conversationId,
    metadata: { deletedMemories: deleted.count, messages: messages.length },
  });

  return { deleted: deleted.count };
}
