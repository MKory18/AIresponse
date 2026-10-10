import type { Db } from "@/modules/customers/service";
import { NotFoundError } from "@/core/errors";
import type { ExclusionReason } from "./segment-schemas";

/**
 * P9 — بوابة أهلية المستلم لحظة الإرسال (إعادة تحقق كاملة — اللقطة قديمة):
 * الشريحة قد تحسب أهلية عميل ثم يُحظر أو يسحب موافقته قبل وصول دوره.
 * كل قرار حتمي من DB، والفشل يُسجل بفئة مغلقة دون بيانات شخصية.
 */

export interface RecipientCheck {
  ok: boolean;
  reason?: ExclusionReason;
  conversationId?: string | null;
  identityExternalId?: string | null;
}

export async function checkRecipientEligibility(
  db: Db,
  input: {
    workspaceId: string;
    customerId: string;
    channelType: string;
    channelId?: string | null;
    requireTemplate: boolean;
  }
): Promise<RecipientCheck> {
  const customer = await db.customer.findUnique({ where: { id: input.customerId } });
  if (!customer || customer.workspaceId !== input.workspaceId) {
    return { ok: false, reason: "BLACKLISTED" }; // غياب العميل في مساحتنا = استبعاد صامت
  }
  if (customer.isBlacklisted) return { ok: false, reason: "BLACKLISTED" };
  if (customer.marketingConsent === "OPTED_OUT" || customer.marketingOptOutAt) return { ok: false, reason: "OPTED_OUT" };
  if (customer.marketingConsent !== "OPTED_IN") return { ok: false, reason: "NO_CONSENT" };

  // قناة الاتصال: هوية موثوقة على نوع قناة الحملة — وجود رقم/معرف آخر لا يكفي.
  const identity = await db.channelIdentity.findFirst({
    where: {
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      channelType: input.channelType as never,
    },
    select: { channelExternalId: true },
  });
  if (!identity) return { ok: false, reason: "NO_CHANNEL_CONTACT" };

  // المحادثة: نعيد استخدام آخر محادثة غير محذوفة على القناة (حتى في مسار
  // القوالب — إعادة المحاولة يجب ألا تنشئ سلسلة مكررة)، وإلا ننشئ
  // سلسلة حملة مميزة (dispatchOutbound يُشترط وجود محادثة).
  const conversation = await db.conversation.findFirst({
    where: {
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      deletedAt: null,
      channel: { type: input.channelType as never, workspaceId: input.workspaceId },
    },
    orderBy: { lastCustomerMessageAt: "desc" },
    select: { id: true },
  });
  return { ok: true, conversationId: conversation?.id ?? null, identityExternalId: identity.channelExternalId };
}

/** حملة WhatsApp تفرض قالبًا معتمدًا (المسار الرسمي الوحيد للتسويق). */
export function campaignRequiresTemplate(channelType: string): boolean {
  return channelType === "WHATSAPP";
}

export async function getOwnedCampaignOrThrow(db: Db, workspaceId: string, campaignId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== workspaceId) throw new NotFoundError("Campaign");
  return campaign as unknown as Record<string, unknown>;
}
