import { childLogger } from "@/core/logger";

const log = childLogger("channels.send-policy");

/**
 * وضع الإرسال يُقرأ من قاعدة البيانات **لحظة الإرسال النهائي** — لا من قيمة
 * مخزّنة بالذاكرة ولا من الواجهة. أي تعذّر في القراءة = رفض (فشل آمن).
 */
export type ChannelSendModeValue = "AUTO_REPLY" | "COLLECTION_ONLY" | "UNKNOWN";

type PolicyDb = {
  conversation: {
    findUnique: (args: unknown) => Promise<{
      id?: string;
      workspaceId?: string;
      channelId?: string | null;
      channel?: { sendMode?: string | null } | null;
    } | null>;
  };
};

export async function loadConversationSendMode(
  db: PolicyDb,
  params: { workspaceId: string; conversationId: string }
): Promise<ChannelSendModeValue> {
  try {
    // استعلام واحد فقط: العلاقة مع القناة تُجلب مع المحادثة (لا استعلام ثانٍ
    // على قناة الإرسال في كل رد — ميزانية الأداء محفوظة).
    const conv = await db.conversation.findUnique({
      where: { id: params.conversationId },
      include: { channel: { select: { sendMode: true } } },
    });
    if (!conv || conv.workspaceId !== params.workspaceId || !conv.channelId) return "UNKNOWN";
    const channel = (conv as { channel?: { sendMode?: string | null } | null }).channel;
    if (!channel) return "UNKNOWN";
    // الصفوف القديمة/الوهمية قبل الترحيل لا تحمل الحقل — الافتراضي هو AUTO_REPLY
    // (نفس افتراضي العمود في قاعدة البيانات).
    if (channel.sendMode === undefined) return "AUTO_REPLY";
    if (channel.sendMode === "AUTO_REPLY" || channel.sendMode === "COLLECTION_ONLY") {
      return channel.sendMode;
    }
    return "UNKNOWN";
  } catch (err) {
    // سجل بمعرّفات فقط — بلا نص رسالة أو بيانات عميل.
    log.error({ err, conversationId: params.conversationId, workspaceId: params.workspaceId }, "send_mode_lookup_failed");
    return "UNKNOWN";
  }
}

export type SendPolicyDecision =
  | { allowed: true; mode: ChannelSendModeValue | "HUMAN" }
  | { allowed: false; mode: ChannelSendModeValue; reason: "COLLECTION_ONLY" | "SEND_MODE_UNKNOWN" };

/**
 * حارس الإرسال الآلي.
 *
 * - الرد اليدوي من موظف مخوّل (`senderType === "HUMAN"`) يبقى وفق سياسة النظام
 *   الحالية — وضع التجميع يمنع الآلي فقط.
 * - كل ما تبقّى (AI · SYSTEM · حملات · أتمتة · متابعة · إعادة محاولة · كنس
 *   المهام العالقة) يمرّ من هنا ويُرفض إذا كانت الصفحة COLLECTION_ONLY.
 * - تعذّر معرفة الوضع = رفض (SEND_MODE_UNKNOWN) — لا إرسال أعمى.
 */
export async function assertAutomatedSendAllowed(
  db: PolicyDb,
  params: { workspaceId: string; conversationId: string; senderType?: string | null }
): Promise<SendPolicyDecision> {
  if (params.senderType === "HUMAN") return { allowed: true, mode: "HUMAN" };
  const mode = await loadConversationSendMode(db, params);
  if (mode === "AUTO_REPLY") return { allowed: true, mode };
  if (mode === "COLLECTION_ONLY") {
    log.warn(
      { conversationId: params.conversationId, workspaceId: params.workspaceId, senderType: params.senderType ?? "AI" },
      "automated_send_blocked_collection_only"
    );
    return { allowed: false, mode, reason: "COLLECTION_ONLY" };
  }
  log.error(
    { conversationId: params.conversationId, workspaceId: params.workspaceId, senderType: params.senderType ?? "AI" },
    "automated_send_blocked_send_mode_unknown"
  );
  return { allowed: false, mode, reason: "SEND_MODE_UNKNOWN" };
}
