import { resolveRange, type RangeQuery } from "@/core/analytics/time";
import type { Db } from "@/modules/customers/service";

/**
 * P10 — تحليلات الحملات التسويقية (قراءة فقط — لا تلمس Idempotency ولا حالة).
 *
 * فصل دلالي إلزامي:
 * - "SENT" على المستلم = قبول API من المزود (wamid) — وليس تسليمًا ولا قراءة.
 * - التسليم/القراءة = من Message.deliveryStatus عبر webhooks الحالة فقط؛ النظام
 *   حاليًا لا يعالج webhooks الحالة (موثق في P5) → يُعرض العدد الفعلي مع علامة
 *   UNVERIFIED، ولا يُدّعى تسليم بدون إثبات.
 * - المستلمون في لقطة الجمهور ≠ الرسائل المرسلة (استبعادات لحظية).
 * - الطلبات المنسوبة لحملة: Order لا يحمل campaignId (لا دليل موثوق) →
 *   UNAVAILABLE — لا ROAS ولا تحويل منسوب بلا تكلفة/إسناد موثق.
 * - CampaignEvent سجل أحداث append-only يُقرأ كما هو — إعادة التسليم لا تكرره
 *   (Idempotency من P9) والمقاييس تقرأ الصفوف ولا تعيد معالجتها.
 */

export async function getCampaignAnalytics(db: Db, workspaceId: string, q: RangeQuery) {
  const { start, end } = resolveRange(q);
  const range = { gte: start, lt: end };

  // حملات الفترة أولًا (يُبنى عليها استعلاما المستلمين والأحداث)
  const [createdInRange, allStatuses, campaignsInRange] = await Promise.all([
    db.campaign.count({ where: { workspaceId, createdAt: range } }),
    db.campaign.findMany({ where: { workspaceId }, select: { status: true } }),
    db.campaign.findMany({ where: { workspaceId, createdAt: range }, select: { id: true, channelType: true, status: true } }),
  ]);
  const campaignIds = campaignsInRange.length ? campaignsInRange.map((c) => c.id) : ["-none-"];
  const [recipients, events] = await Promise.all([
    db.campaignRecipient.findMany({
      where: { workspaceId, campaignId: { in: campaignIds } },
      select: { status: true, excludeReason: true, customerId: true, messageId: true, errorCategory: true },
    }),
    db.campaignEvent.findMany({
      where: { workspaceId, campaignId: { in: campaignIds } },
      select: { type: true, reason: true, count: true },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const c of allStatuses) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;

  const byStatus: Record<string, number> = {};
  for (const r of recipients) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const byExcludeReason: Record<string, number> = {};
  for (const r of recipients) {
    if (r.status === "EXCLUDED") byExcludeReason[r.excludeReason ?? "UNKNOWN"] = (byExcludeReason[r.excludeReason ?? "UNKNOWN"] ?? 0) + 1;
  }

  // التسليم/القراءة: من رسائل المستلمين (webhooks الحالة فقط — حاليًا غير معالجة)
  const messageIds = recipients.map((r) => r.messageId).filter((x): x is string => Boolean(x));
  const msgs = messageIds.length
    ? await db.message.findMany({ where: { workspaceId, id: { in: messageIds } }, select: { id: true, deliveryStatus: true } })
    : [];
  const deliveryByMessage = new Map(msgs.map((m) => [m.id, m.deliveryStatus]));
  let deliveryConfirmed = 0;
  let readConfirmed = 0;
  for (const id of messageIds) {
    const st = deliveryByMessage.get(id);
    if (st === "DELIVERED" || st === "READ") deliveryConfirmed += 1;
    if (st === "READ") readConfirmed += 1;
  }
  const hasDeliveryVerification = msgs.some((m) => m.deliveryStatus === "DELIVERED" || m.deliveryStatus === "READ");

  const eventsByType: Record<string, number> = {};
  for (const e of events) eventsByType[e.type] = (eventsByType[e.type] ?? 0) + Math.max(0, Number(e.count ?? 0));

  const byErrorCategory: Record<string, number> = {};
  for (const r of recipients) {
    if (r.errorCategory) byErrorCategory[r.errorCategory] = (byErrorCategory[r.errorCategory] ?? 0) + 1;
  }

  const byChannel: Record<string, number> = {};
  for (const c of campaignsInRange) byChannel[c.channelType] = (byChannel[c.channelType] ?? 0) + 1;

  return {
    campaigns: {
      createdInRange,
      statusDistribution: statusCounts, // الحالة الحالية لكل حملات المؤسسة
      byChannelInRange: byChannel,
    },
    audience: {
      // لقطة الجمهور (مستلمون فريدون) — ليست رسائل مرسلة
      uniqueRecipients: new Set(recipients.map((r) => r.customerId)).size,
      recipientRows: recipients.length,
      byStatus,
      byExcludeReason,
      excluded: byStatus.EXCLUDED ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      failed: byStatus.FAILED ?? 0,
      byErrorCategory,
    },
    sending: {
      // قبول المزود فقط (SENT) — لا يُدّعى تسليم
      apiAccepted: byStatus.SENT ?? 0,
      deliveryConfirmed,
      readConfirmed,
      deliveryVerification: hasDeliveryVerification ? "VERIFIED_BY_STATUS_WEBHOOK" : "UNVERIFIED_NO_STATUS_WEBHOOK_DATA",
      eventsByType,
    },
    attribution: {
      attributedOrders: null as number | null,
      status: "UNAVAILABLE" as const,
      reason: "ORDER_HAS_NO_CAMPAIGN_ATTRIBUTION",
      roas: null as number | null,
      roasReason: "NO_TRUSTED_AD_COST_OR_ATTRIBUTED_SALES",
    },
  };
}
