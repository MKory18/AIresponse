import { AppError, NotFoundError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { channelKey } from "./format";

/**
 * P12 — موافقة الزبون على الرسائل التسويقية (كانت ناقصة كليًا: الحقل موجود
 * منذ P9 لكن ولا مكان بيكتبه، فكل حملة كانت تطلع لصفر شخص).
 *
 * - الإلغاء أسهل من الاشتراك: كلمة «إيقاف»/STOP كرسالة كاملة من الزبون
 *   تلغي فورًا (CUSTOMER_KEYWORD) — بلا تخمين من كلام طويل.
 * - الاشتراك لا يُستنتج أبدًا من كلام الزبون: الموظف يسجّله صراحة بعد
 *   موافقة الزبون (AGENT) — والعودة بعد إلغاء تحتاج تأكيد صريح.
 * - كل تغيير بالسجل بمصدره، والإلغاء يُبلَّغ للكليبر إذا الزبون جه برمز.
 */

const log = childLogger("integrations.consent");

function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰ]/g, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

/** عبارات إلغاء صريحة (بعد التطبيع) — الرسالة كلها لازم تكون واحدة منها. */
const OPT_OUT_PHRASES = new Set(
  [
    "ايقاف",
    "إيقاف",
    "توقف",
    "stop",
    "unsubscribe",
    "الغاء الاشتراك",
    "إلغاء الاشتراك",
    "ايقاف الاشتراك",
    "ايقاف الرسائل",
    "ايقاف العروض",
    "اوقف الرسائل",
    "لا ترسلوا",
    "لا ترسل",
    "لا تراسلني",
    "لا تبعتولي",
    "بطلوا تبعتولي",
    "stop all",
  ].map(normalizeArabic)
);

/** هل الرسالة طلب إلغاء صريح؟ (رسالة قصيرة كاملة = العبارة فقط). */
export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = normalizeArabic(text)
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 40) return false;
  return OPT_OUT_PHRASES.has(t);
}

type CustomerRow = {
  id: string;
  workspaceId: string;
  marketingConsent: string;
  marketingOptOutAt: Date | string | null;
};

export interface ConsentChange {
  changed: boolean;
  consent: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
}

/** إلغاء الاشتراك (من كلمة الزبون أو من الموظف). لا يرمي من مسار الرسائل. */
export async function applyOptOut(
  db: Db,
  input: { workspaceId: string; customerId: string; conversationId?: string | null; channelType?: string | null; source: "CUSTOMER_KEYWORD" | "AGENT"; userId?: string | null }
): Promise<ConsentChange> {
  const customer = (await db.customer.findUnique({ where: { id: input.customerId } })) as CustomerRow | null;
  if (!customer || customer.workspaceId !== input.workspaceId) return { changed: false, consent: "UNKNOWN" };
  if (customer.marketingConsent === "OPTED_OUT") return { changed: false, consent: "OPTED_OUT" };
  await db.customer.update({
    where: { id: customer.id },
    data: { marketingConsent: "OPTED_OUT", marketingOptOutAt: new Date(), marketingConsentSource: input.source } as never,
  });
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    action: "customer.marketing_opted_out",
    entityType: "Customer",
    entityId: customer.id,
    metadata: { source: input.source },
  });
  try {
    const { emitOptOutIfCoded } = await import("./clipper");
    await emitOptOutIfCoded(db, {
      workspaceId: input.workspaceId,
      customerId: customer.id,
      conversationId: input.conversationId ?? null,
      // قناة غير معروفة = فاضي (قناة لمسة الرمز بتنستخدم) — مش «web» مخترعة.
      channel: input.channelType ? channelKey(input.channelType) : "",
    });
  } catch (err) {
    log.warn({ err }, "opt_out_emit_failed");
  }
  return { changed: true, consent: "OPTED_OUT" };
}

/**
 * الموظف يسجّل موافقة الزبون أو إلغاءه (صلاحية customers.write).
 * الاشتراك بعد إلغاء سابق يحتاج reoptIn=true (الزبون طلب صراحة من جديد).
 */
export async function setMarketingConsent(
  db: Db,
  ctx: ActorContext,
  customerId: string,
  input: { consent: "OPTED_IN" | "OPTED_OUT"; reoptIn?: boolean }
): Promise<ConsentChange> {
  const customer = (await db.customer.findUnique({ where: { id: customerId } })) as CustomerRow | null;
  if (!customer || customer.workspaceId !== ctx.workspaceId) throw new NotFoundError("Customer");
  if (input.consent === "OPTED_OUT") {
    const conv = await db.conversation.findFirst({
      where: { workspaceId: ctx.workspaceId, customerId, deletedAt: null },
      orderBy: { lastCustomerMessageAt: "desc" },
      select: { id: true, channelId: true },
    });
    const channel = conv?.channelId ? await db.channel.findUnique({ where: { id: conv.channelId }, select: { type: true } }) : null;
    return applyOptOut(db, {
      workspaceId: ctx.workspaceId,
      customerId,
      conversationId: conv?.id ?? null,
      channelType: channel?.type ?? null,
      source: "AGENT",
      userId: ctx.userId,
    });
  }
  if (customer.marketingConsent === "OPTED_IN") return { changed: false, consent: "OPTED_IN" };
  if ((customer.marketingConsent === "OPTED_OUT" || customer.marketingOptOutAt) && !input.reoptIn) {
    throw new AppError("الزبون ألغى الاشتراك سابقًا — الاشتراك من جديد يحتاج طلب صريح منه (أكّد ذلك)", 409, "REOPT_IN_REQUIRES_CONFIRMATION");
  }
  await db.customer.update({
    where: { id: customerId },
    data: {
      marketingConsent: "OPTED_IN",
      marketingConsentAt: new Date(),
      marketingOptOutAt: null,
      marketingConsentSource: "AGENT",
    } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "customer.marketing_opted_in",
    entityType: "Customer",
    entityId: customerId,
    metadata: { source: "AGENT", reoptIn: Boolean(input.reoptIn) },
  });
  return { changed: true, consent: "OPTED_IN" };
}

export interface CustomerMarketingView {
  consent: string;
  consentAt: string | null;
  optOutAt: string | null;
  consentSource: string | null;
  /** آخر لمسة إسناد (بلا المعرّفات المشفّرة) — مصدر الزبون بلمحة. */
  attribution: {
    channel: string;
    kind: string;
    source: string;
    adId: string | null;
    refCode: string | null;
    codeStatus: string | null;
    occurredAt: string;
  } | null;
}

/** حالة الموافقة + آخر مصدر إسناد للزبون (لوحة الزبون بالمحادثة). */
export async function getCustomerMarketingView(db: Db, workspaceId: string, customerId: string): Promise<CustomerMarketingView> {
  const customer = (await db.customer.findUnique({ where: { id: customerId } })) as
    | (CustomerRow & { marketingConsentAt?: Date | string | null; marketingConsentSource?: string | null })
    | null;
  if (!customer || customer.workspaceId !== workspaceId) throw new NotFoundError("Customer");
  const touch = (await (db as unknown as { attributionTouch?: { findFirst: (a: unknown) => Promise<unknown> } }).attributionTouch?.findFirst({
    where: { workspaceId, customerId },
    orderBy: { occurredAt: "desc" },
    select: { channel: true, kind: true, source: true, adId: true, refCode: true, codeStatus: true, occurredAt: true },
  })) as
    | { channel: string; kind: string; source: string; adId: string | null; refCode: string | null; codeStatus: string | null; occurredAt: Date | string }
    | null
    | undefined;
  const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
  return {
    consent: customer.marketingConsent ?? "UNKNOWN",
    consentAt: iso(customer.marketingConsentAt),
    optOutAt: iso(customer.marketingOptOutAt),
    consentSource: customer.marketingConsentSource ?? null,
    attribution: touch
      ? {
          channel: touch.channel,
          kind: touch.kind,
          source: touch.source,
          adId: touch.adId,
          refCode: touch.refCode,
          codeStatus: touch.codeStatus,
          occurredAt: new Date(touch.occurredAt).toISOString(),
        }
      : null,
  };
}
