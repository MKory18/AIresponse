import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { captureAttribution, type InboundReferral } from "./attribution";
import { applyOptOut, isOptOutMessage } from "./consent";

/**
 * P12 — ما يجري لكل رسالة زبون جديدة بعد حفظها (لا قبلها، ولا يوقفها أبدًا):
 * 1. الإسناد: لمسة إعلان/رمز من بيانات موثوقة (حلقة «بداية المحادثة»).
 * 2. الرمز الجديد ← مهمة تحقق من الكليبر ← conversation.coded.
 * 3. «إيقاف»/STOP كرسالة كاملة ← إلغاء الاشتراك التسويقي + opt_out للكليبر.
 */

const log = childLogger("integrations.inbound");

/** نسخة آمنة من الإحالة للحفظ مع الرسالة (بلا ctwa_clid — يُحفظ مشفّرًا باللمسة فقط). */
export function safeReferralForStorage(ref: unknown): Record<string, unknown> | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const r = ref as Record<string, unknown>;
  return {
    source: r.source ?? null,
    adId: r.adId ?? null,
    adSourceType: r.adSourceType ?? null,
    ref: r.ref ?? null,
    pageId: r.pageId ?? null,
  };
}

export function parseReferral(meta: Record<string, unknown> | undefined | null): InboundReferral | null {
  const r = meta?.referral;
  if (!r || typeof r !== "object") return null;
  const v = r as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 512) : null);
  const source = str(v.source);
  const allowed = ["wa_referral", "fb_referral", "ig_referral", "fb_ref_link", "ig_ref_link"];
  if (!source || !allowed.includes(source)) return null;
  return {
    source: source as InboundReferral["source"],
    adId: str(v.adId),
    adSourceType: str(v.adSourceType),
    ref: str(v.ref),
    ctwaClid: str(v.ctwaClid),
    pageId: str(v.pageId),
    wabaId: str(v.wabaId),
  };
}

export interface InboundHookInput {
  workspaceId: string;
  customerId: string;
  conversationId: string;
  channelType: string;
  messageId: string;
  externalEventId: string;
  externalUserId: string;
  text: string | null;
  referral: InboundReferral | null;
  occurredAt: Date;
}

export async function onInboundCustomerMessage(db: Db, input: InboundHookInput): Promise<void> {
  try {
    const touches = await captureAttribution(db, {
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      conversationId: input.conversationId,
      channelType: input.channelType,
      eventKey: input.externalEventId || input.messageId,
      messageId: input.messageId,
      text: input.text,
      referral: input.referral,
      externalUserId: input.externalUserId,
      occurredAt: input.occurredAt,
    });
    if (touches.length > 0) {
      // مصدر الزبون الأول (P8) يبقى «لمسة أولى إلى الأبد» — يُملأ هنا للقنوات الجديدة.
      const first = touches[0];
      const { recordAdSource } = await import("@/modules/sales/ad-source");
      const src =
        first.kind === "AD" && input.referral?.adId ? `ad:${input.referral.adId}` : first.refCode ? `code:${first.refCode}` : null;
      if (src) await recordAdSource(db, { workspaceId: input.workspaceId, customerId: input.customerId, source: src }).catch(() => undefined);
      const { afterCodeCaptured } = await import("./clipper");
      for (const t of touches) if (t.kind === "CODE") await afterCodeCaptured(db, input.workspaceId, t.id);
    }
  } catch (err) {
    log.error({ err, conversationId: input.conversationId }, "inbound_attribution_failed");
  }
  try {
    if (isOptOutMessage(input.text)) {
      await applyOptOut(db, {
        workspaceId: input.workspaceId,
        customerId: input.customerId,
        conversationId: input.conversationId,
        channelType: input.channelType,
        source: "CUSTOMER_KEYWORD",
      });
    }
  } catch (err) {
    log.error({ err, conversationId: input.conversationId }, "inbound_opt_out_failed");
  }
}
