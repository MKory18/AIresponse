/**
 * الرد الأخير (شبكة أمان): لما مهمة الرد تخلص كل محاولاتها وتفشل، رسالة
 * الزبون بتضل بلا أي رد — وهاد اللي كان بيصير قبل. هون منبعت نص ثابت آمن
 * بلا سعر ولا وصف منتج ولا وعد، بس عشان الزبون ما ينحرد ويحكي مرة تانية.
 *
 * ما منلمس مسار الرد العادي: كل المحاولات وإعادة التوليد والترتيب بتصير
 * زي ما هي، وهاد بيشتغل بعدها بس.
 */
import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";

const log = childLogger("ai.last-resort");

/** نص ثابت آمن — ما بيمرّ على الموديل ولا بيحمل أي معلومة منتج. */
export const LAST_RESORT_REPLY = "وصلتني رسالتك 🌹 ممكن تبعتلي إياها مرة تانية أو توضّحلي أكتر شو بدك؟";

export interface LastResortParams {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  reason: string;
}

/**
 * بيبعت الرد الأخير إذا كان لازم. بيرجع سبب التخطّي أو "SENT".
 *
 * ما بيبعت إذا:
 * - المحادثة انتقلت لموظف (الموظف بيرد بنفسه)،
 * - الذكاء مطفي عالمحادثة،
 * - الزبون أصلًا أخد رد بعد هالرسالة (رسالة أحدث انردّ عليها).
 */
export async function sendLastResortReply(
  db: Db,
  params: LastResortParams
): Promise<"SENT" | "SKIPPED_HUMAN" | "SKIPPED_ANSWERED" | "SKIPPED_NO_CONVERSATION" | "FAILED"> {
  try {
    const conversation = (await db.conversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      select: { id: true, aiState: true, aiEnabled: true, deletedAt: true },
    })) as { id: string; aiState: string; aiEnabled: boolean; deletedAt: Date | null } | null;
    if (!conversation || conversation.deletedAt) return "SKIPPED_NO_CONVERSATION";
    if (!conversation.aiEnabled || conversation.aiState !== "AI_ACTIVE") return "SKIPPED_HUMAN";

    const inbound = (await db.message.findFirst({
      where: { id: params.messageId, conversationId: params.conversationId },
      select: { createdAt: true },
    })) as { createdAt: Date | string } | null;
    if (!inbound) return "SKIPPED_NO_CONVERSATION";

    // رد طلع بعد هالرسالة = الزبون مش ساكت عليه؛ ما منزيد رد تاني.
    const outbound = (await db.message.findMany({
      where: {
        conversationId: params.conversationId,
        direction: "OUTBOUND",
        deliveryStatus: { in: ["SENT", "DELIVERED", "READ"] },
      },
      select: { createdAt: true },
    })) as unknown as Array<{ createdAt: Date | string }>;
    const at = (v: Date | string) => new Date(v).getTime();
    const answered = outbound.some((m) => at(m.createdAt) > at(inbound.createdAt));
    if (answered) return "SKIPPED_ANSWERED";

    const { dispatchOutbound } = await import("@/modules/channels/outbound");
    const sent = await dispatchOutbound(db, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      // مفتاح خاص فيه: إعادة المحاولة ما بتبعت الرد مرتين.
      sourceMessageId: `${params.messageId}:last-resort`,
      text: LAST_RESORT_REPLY,
    });
    if (sent.deliveryStatus !== "SENT" && sent.deliveryStatus !== "SKIPPED_DUPLICATE") {
      log.warn(
        { conversationId: params.conversationId, messageId: params.messageId, deliveryStatus: sent.deliveryStatus },
        "last_resort_not_sent"
      );
      return "FAILED";
    }
    await recordAudit(db, {
      workspaceId: params.workspaceId,
      action: "conversation.last_resort_reply",
      entityType: "Conversation",
      entityId: params.conversationId,
      metadata: { messageId: params.messageId, reason: params.reason },
    });
    log.warn(
      { conversationId: params.conversationId, messageId: params.messageId, reason: params.reason },
      "last_resort_reply_sent"
    );
    return "SENT";
  } catch (err) {
    log.warn(
      { conversationId: params.conversationId, messageId: params.messageId, error: err instanceof Error ? err.message : "failed" },
      "last_resort_failed"
    );
    return "FAILED";
  }
}
