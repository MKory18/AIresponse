import type { Db } from "@/modules/customers/service";
import { captureAttribution, type InboundReferral } from "./attribution";
import { afterCodeCaptured } from "./clipper";

/**
 * P12 — إحالة بلا رسالة (messaging_referrals): زبون له محادثة قائمة كبس
 * إعلانًا أو رابط رمز. تُسجّل لمسة إسناد على محادثته — بلا رسالة ولا رد.
 * محادثة جديدة تمامًا تصل دائمًا مع رسالتها، فلا نخلق محادثات هنا أبدًا.
 */
export async function captureReferralSignals(
  db: Db,
  input: { workspaceId: string; channelType: "FACEBOOK" | "INSTAGRAM"; signals: Array<Record<string, unknown>> }
): Promise<number> {
  let captured = 0;
  for (const s of input.signals) {
    const psid = typeof s.psid === "string" ? s.psid : "";
    const referral = s.referral as InboundReferral | undefined;
    if (!psid || !referral) continue;
    const identity = await db.channelIdentity.findFirst({
      where: { workspaceId: input.workspaceId, channelType: input.channelType as never, channelExternalId: psid },
      select: { customerId: true },
    });
    if (!identity) continue;
    const conversation = await db.conversation.findUnique({
      where: { workspaceId_channelConversationId: { workspaceId: input.workspaceId, channelConversationId: psid } },
      select: { id: true, customerId: true },
    });
    if (!conversation || conversation.customerId !== identity.customerId) continue;
    const touches = await captureAttribution(db, {
      workspaceId: input.workspaceId,
      customerId: identity.customerId,
      conversationId: conversation.id,
      channelType: input.channelType,
      eventKey: String(s.eventKey ?? `${psid}:${String(s.timestamp ?? "")}`),
      referral,
      externalUserId: psid,
      occurredAt: s.timestamp ? new Date(s.timestamp as string) : new Date(),
    });
    captured += touches.length;
    for (const t of touches) if (t.kind === "CODE") await afterCodeCaptured(db, input.workspaceId, t.id);
  }
  return captured;
}
