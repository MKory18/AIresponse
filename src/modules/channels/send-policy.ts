import { childLogger } from "@/core/logger";

const log = childLogger("channels.send-policy");

/**
 * وضع الإرسال يُقرأ من قاعدة البيانات **لحظة الإرسال النهائي** — لا من قيمة
 * مخزّنة بالذاكرة ولا من الواجهة. أي تعذّر في القراءة = رفض (فشل آمن).
 */
export type ChannelSendModeValue = "AUTO_REPLY" | "COLLECTION_ONLY" | "UNKNOWN";

/**
 * Phase 2 — بادئة معرّف محادثة الحملة. الحملة تنشئ سلسلة **مملوكة للنظام**
 * (`aiState: HUMAN_ACTIVE` + `aiEnabled: false`) لتُبثّ بلا ردّ آلي. البادئة
 * هي الفرق الوحيد بين «محادثة بثّ يملكها النظام» و«محادثة زبون استلمها موظف»
 * — تُصدَّر من هنا ويستعملها `campaign-runner` حتى لا تتفرّع القيمة.
 */
export const CAMPAIGN_CONVERSATION_PREFIX = "camp-";

type PolicyDb = {
  conversation: {
    findUnique: (args: unknown) => Promise<{
      id?: string;
      workspaceId?: string;
      channelId?: string | null;
      aiState?: string | null;
      channelConversationId?: string | null;
      channel?: { sendMode?: string | null } | null;
    } | null>;
  };
};

export interface ConversationSendPolicy {
  mode: ChannelSendModeValue;
  aiState: string | null;
  channelConversationId: string | null;
}

/** هل هاد محادثة بثّ يملكها النظام (أنشأتها حملة) — مش محادثة زبون حقيقية؟ */
export function isCampaignConversation(channelConversationId: string | null | undefined): boolean {
  return typeof channelConversationId === "string" && channelConversationId.startsWith(CAMPAIGN_CONVERSATION_PREFIX);
}

/**
 * يقرأ وضع القناة وحالة الوكيل (`aiState`) باستعلام واحد لحظة الإرسال النهائي.
 * أي تعذّر = وضع غير معروف (فشل آمن). الاستعلام واحد فقط (لا استعلام ثانٍ في
 * كل رد — ميزانية الأداء محفوظة).
 */
export async function loadConversationSendPolicy(
  db: PolicyDb,
  params: { workspaceId: string; conversationId: string }
): Promise<ConversationSendPolicy> {
  try {
    const conv = await db.conversation.findUnique({
      where: { id: params.conversationId },
      include: { channel: { select: { sendMode: true } } },
    });
    if (!conv || conv.workspaceId !== params.workspaceId || !conv.channelId) {
      return { mode: "UNKNOWN", aiState: null, channelConversationId: null };
    }
    const aiState = conv.aiState ?? null;
    const channelConversationId = conv.channelConversationId ?? null;
    const channel = (conv as { channel?: { sendMode?: string | null } | null }).channel;
    if (!channel) return { mode: "UNKNOWN", aiState, channelConversationId };
    // الصفوف القديمة/الوهمية قبل الترحيل لا تحمل الحقل — الافتراضي هو AUTO_REPLY
    // (نفس افتراضي العمود في قاعدة البيانات).
    if (channel.sendMode === undefined) return { mode: "AUTO_REPLY", aiState, channelConversationId };
    if (channel.sendMode === "AUTO_REPLY" || channel.sendMode === "COLLECTION_ONLY") {
      return { mode: channel.sendMode, aiState, channelConversationId };
    }
    return { mode: "UNKNOWN", aiState, channelConversationId };
  } catch (err) {
    // سجل بمعرّفات فقط — بلا نص رسالة أو بيانات عميل.
    log.error({ err, conversationId: params.conversationId, workspaceId: params.workspaceId }, "send_mode_lookup_failed");
    return { mode: "UNKNOWN", aiState: null, channelConversationId: null };
  }
}

/** Backwards-compatible accessor (mode only). */
export async function loadConversationSendMode(
  db: PolicyDb,
  params: { workspaceId: string; conversationId: string }
): Promise<ChannelSendModeValue> {
  return (await loadConversationSendPolicy(db, params)).mode;
}

export type SendPolicyDecision =
  | { allowed: true; mode: ChannelSendModeValue | "HUMAN" }
  | { allowed: false; mode: ChannelSendModeValue; reason: "COLLECTION_ONLY" | "SEND_MODE_UNKNOWN" | "HUMAN_ACTIVE" };

/**
 * حارس الإرسال الآلي — نقطة القرار النهائية على مستوى الخادم.
 *
 * - الرد اليدوي من موظف مخوّل (`senderType === "HUMAN"`) يبقى مسموحًا دائمًا —
 *   المنع يشمل الآلي فقط (AI · نظام · حملات · أتمتة · متابعة · إعادة محاولة ·
 *   كنس المهام العالقة).
 * - **Phase 2:** لو الموظف استلم المحادثة (`aiState === "HUMAN_ACTIVE"`) يُرفض
 *   أي إرسال آلي — حتى لو بدأ قبل الاستلام، أو جاء من عامل قديم أو حملة.
 * - الصفحة COLLECTION_ONLY ترفض الآلي كذلك.
 * - تعذّر معرفة الوضع = رفض (SEND_MODE_UNKNOWN) — لا إرسال أعمى.
 */
export async function assertAutomatedSendAllowed(
  db: PolicyDb,
  params: { workspaceId: string; conversationId: string; senderType?: string | null }
): Promise<SendPolicyDecision> {
  if (params.senderType === "HUMAN") return { allowed: true, mode: "HUMAN" };
  const { mode, aiState, channelConversationId } = await loadConversationSendPolicy(db, params);
  // Phase 2 — بعد استلام الموظف (`HUMAN_ACTIVE`) لا يوصل أي إرسال آلي للزبون:
  // AI · أتمتة · متابعة · نظام — **ولا حملة**. الاستثناء الوحيد: بثّ حملة على
  // سلسلة **يملكها النظام** أنشأتها الحملة نفسها (`camp-…`, `aiEnabled:false`)؛
  // هي قناة بثّ مقصودة، مش محادثة زبون استلمها موظف. حملة على محادثة زبون
  // استلمها موظف تُرفض مثل أي آلي.
  const campaignOwned = params.senderType === "CAMPAIGN" && isCampaignConversation(channelConversationId);
  if (aiState === "HUMAN_ACTIVE" && !campaignOwned) {
    log.warn(
      { conversationId: params.conversationId, workspaceId: params.workspaceId, senderType: params.senderType ?? "AI" },
      "automated_send_blocked_human_active"
    );
    return { allowed: false, mode, reason: "HUMAN_ACTIVE" };
  }
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
