import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { channelKey } from "./format";
import { getIntegrationSettings } from "./settings";

/**
 * P12 — الإسناد: من أي إعلان أو رمز كليبر إجت المحادثة، ولمين ينحسب الطلب.
 *
 * مصادر موثوقة فقط (لا تخمين من الكلام إلا الرمز الصريح):
 * - واتساب: messages[].referral (source_id = رقم الإعلان · ctwa_clid) + WABA.
 * - ماسنجر/إنستغرام: referral (ad_id · ref) مع الرسالة أو حدث إحالة مستقل.
 * - رمز الكليبر: referral.ref من رابط m.me/ig.me، أو «رمز K7Q2» صريحًا
 *   بالرسالة، أو /start K7Q2 بتيليجرام.
 *
 * «بداية المحادثة بتحكم» (عقد الكليبر LG04 والميديا باير LG04): أول لمسة
 * تفتح حلقة (episodeStart) بنافذة attributionWindowDays، وأي لمسة داخل
 * الحلقة تُسجَّل للتدقيق لكنها لا تسرق الإسناد — ولا طلب ينحسب مرتين.
 * ctwa_clid والـ PSID يُشفّران فورًا ولا يظهران بأي شاشة أو سجل.
 */

const log = childLogger("integrations.attribution");

/** أقصى عمر للمسة تُنسب لها طلبية (بعدها الطلب «بلا إسناد»). */
export const MAX_ATTRIBUTION_AGE_DAYS = 28;

export interface InboundReferral {
  source: "wa_referral" | "fb_referral" | "ig_referral" | "fb_ref_link" | "ig_ref_link";
  adId?: string | null;
  adSourceType?: string | null;
  ref?: string | null;
  ctwaClid?: string | null;
  pageId?: string | null;
  wabaId?: string | null;
}

export interface AttributionCandidate {
  kind: "AD" | "CODE";
  source: string;
  adId?: string | null;
  adSourceType?: string | null;
  ctwaClid?: string | null;
  refCode?: string | null;
  pageId?: string | null;
  wabaId?: string | null;
}

const CODE_RE = /^[A-Z0-9]{4,12}$/;

function toLatinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** يطبّع رمزًا محتملًا (أحرف لاتينية كبيرة وأرقام) أو null. */
export function normalizeCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = toLatinDigits(String(raw)).trim().toUpperCase();
  // أرقام بس = مش رمز (ممكن يكون رقم هاتف أو طلب) — ما بينلقط ولا بينبعت للكليبر.
  if (/^\d+$/.test(v)) return null;
  return CODE_RE.test(v) ? v : null;
}

// «رمز K7Q2» · «الرمز: K7Q2» · «كود K7Q2» · «code K7Q2» · «ref K7Q2» — كلمة
// مفتاحية صريحة إلزامية، فلا يُلتقط أي رقم عابر من كلام الزبون.
const TEXT_CODE_RE =
  /(?:^|[\s:،,.(«"'])(?:رمز|الرمز|كود|الكود|code|ref)\s*[:：#\-]?\s*([A-Za-z0-9٠-٩۰-۹]{4,12})(?=$|[\s.,،!؟?)»"'])/iu;
const TG_START_RE = /^\/start\s+([A-Za-z0-9_-]{3,64})\s*$/;

/** رمز صريح من نص الرسالة (أو /start بتيليجرام) — null إذا ما في. */
export function detectCodeInText(text: string | null | undefined, channelType?: string): { code: string; source: string } | null {
  if (!text) return null;
  const t = text.trim();
  if (t.length === 0 || t.length > 300) return null; // رسالة طويلة = كلام، مش رابط رمز
  if ((channelType ?? "").toUpperCase() === "TELEGRAM") {
    const m = t.match(TG_START_RE);
    if (m) {
      const code = normalizeCode(m[1].replace(/^(ref|code)[_-]/i, ""));
      return code ? { code, source: "tg_start" } : null;
    }
  }
  const m = t.match(TEXT_CODE_RE);
  if (!m) return null;
  const code = normalizeCode(m[1]);
  return code ? { code, source: "text_code" } : null;
}

/** المرشّحون للمسة من رسالة/حدث واحد (إعلان أو رمز). */
export function attributionCandidates(input: {
  channelType: string;
  text?: string | null;
  referral?: InboundReferral | null;
}): AttributionCandidate[] {
  const out: AttributionCandidate[] = [];
  const r = input.referral;
  if (r && r.adId) {
    out.push({
      kind: "AD",
      source: r.source,
      adId: String(r.adId).slice(0, 64),
      adSourceType: r.adSourceType ? String(r.adSourceType).toLowerCase().slice(0, 16) : "ad",
      ctwaClid: r.ctwaClid ?? null,
      pageId: r.pageId ?? null,
      wabaId: r.wabaId ?? null,
    });
  } else if (r && r.ref) {
    // رابط m.me/ig.me برمز كليبر (بلا رقم إعلان) — «ref=K7Q2».
    const code = normalizeCode(r.ref);
    if (code) out.push({ kind: "CODE", source: r.source, refCode: code, pageId: r.pageId ?? null });
  }
  if (!out.some((c) => c.kind === "CODE")) {
    const fromText = detectCodeInText(input.text, input.channelType);
    if (fromText) out.push({ kind: "CODE", source: fromText.source, refCode: fromText.code, pageId: r?.pageId ?? null });
  }
  return out;
}

type TouchRow = {
  id: string;
  workspaceId: string;
  customerId: string;
  conversationId: string;
  channel: string;
  kind: string;
  source: string;
  adId: string | null;
  adSourceType: string | null;
  ctwaClidEnc: string | null;
  refCode: string | null;
  codeStatus: string | null;
  pageId: string | null;
  psidEnc: string | null;
  wabaId: string | null;
  episodeStart: boolean;
  occurredAt: Date | string;
};

interface TouchModel {
  create(a: unknown): Promise<unknown>;
  findFirst(a: unknown): Promise<unknown>;
  findMany(a: unknown): Promise<unknown>;
  update(a: unknown): Promise<unknown>;
}

function touches(db: Db): TouchModel | null {
  return (db as unknown as { attributionTouch?: TouchModel }).attributionTouch ?? null;
}

/**
 * مفتاح عدم التكرار مهشور: المفتاح الخام ممكن يحوي PSID (حدث إحالة بلا
 * رسالة) — والـ PSID ما بينخزّن نص صريح إلا مشفّر.
 */
export function touchDedupeKey(raw: string): string {
  return `t_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
}

function safeEncrypt(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    return encryptSecret(String(v).slice(0, 512));
  } catch {
    return null;
  }
}

export interface CaptureInput {
  workspaceId: string;
  customerId: string;
  conversationId: string;
  channelType: string;
  /** معرّف الحدث الخارجي (إزالة تكرار إعادة الإرسال). */
  eventKey: string;
  messageId?: string | null;
  text?: string | null;
  referral?: InboundReferral | null;
  /** معرّف المستخدم على الصفحة (PSID/IGSID) — يُشفّر للتحويلات فقط. */
  externalUserId?: string | null;
  occurredAt?: Date;
}

export interface CapturedTouch {
  id: string;
  kind: "AD" | "CODE";
  episodeStart: boolean;
  refCode: string | null;
}

/**
 * يسجّل لمسات الإسناد لرسالة/حدث. لا يرمي أبدًا (الإسناد لا يوقف الرسالة).
 * يرجّع اللمسات الجديدة (لا المكررة) — المستدعي يجدول التحقق من الرمز.
 */
export async function captureAttribution(db: Db, input: CaptureInput): Promise<CapturedTouch[]> {
  const model = touches(db);
  if (!model) return [];
  try {
    const candidates = attributionCandidates({ channelType: input.channelType, text: input.text, referral: input.referral });
    if (candidates.length === 0) return [];
    const settings = await getIntegrationSettings(db, input.workspaceId);
    const windowMs = settings.attributionWindowDays * 24 * 3600_000;
    const at = input.occurredAt ?? new Date();
    const channel = channelKey(input.channelType);
    const captured: CapturedTouch[] = [];
    for (const c of candidates) {
      const last = (await model.findFirst({
        where: { workspaceId: input.workspaceId, conversationId: input.conversationId, episodeStart: true },
        orderBy: { occurredAt: "desc" },
      })) as TouchRow | null;
      const episodeOpen = last ? at.getTime() - new Date(last.occurredAt).getTime() < windowMs : false;
      // رمز لا يشبه رمزًا حقيقيًا (أرقام فقط مثلًا) لا يفتح حلقة قبل أن يتحقق
      // منه الكليبر — حتى لا يحجب إعلانًا حقيقيًا يجي بعده.
      const episodeStart = !episodeOpen && (c.kind === "AD" || codeLooksReal(c.refCode ?? ""));
      const psid = channel === "messenger" || channel === "instagram" ? input.externalUserId ?? null : null;
      try {
        const row = (await model.create({
          data: {
            workspaceId: input.workspaceId,
            customerId: input.customerId,
            conversationId: input.conversationId,
            channel,
            kind: c.kind,
            source: c.source,
            adId: c.adId ?? null,
            adSourceType: c.adSourceType ?? null,
            ctwaClidEnc: safeEncrypt(c.ctwaClid),
            refCode: c.refCode ?? null,
            codeStatus: c.kind === "CODE" ? "UNVERIFIED" : null,
            pageId: c.pageId ?? null,
            psidEnc: c.kind === "AD" ? safeEncrypt(psid) : null,
            wabaId: c.wabaId ?? null,
            messageId: input.messageId ?? null,
            episodeStart,
            dedupeKey: touchDedupeKey(`${input.conversationId}:${c.kind}:${input.eventKey}`),
            occurredAt: at,
          },
        })) as TouchRow;
        captured.push({ id: row.id, kind: c.kind, episodeStart, refCode: row.refCode });
      } catch (err) {
        if ((err as { code?: string })?.code !== "P2002") throw err; // مكرر = سُجّل سابقًا
      }
    }
    return captured;
  } catch (err) {
    log.error({ err, conversationId: input.conversationId }, "attribution_capture_failed");
    return [];
  }
}

export interface OrderAttribution {
  method: "AD" | "CODE" | "NONE";
  channel: string | null;
  adId: string | null;
  adSourceType: string | null;
  ctwaClidEnc: string | null;
  refCode: string | null;
  refCodeAt: Date | null;
  touchAt: Date | null;
  pageRef: string | null;
  psidEnc: string | null;
  wabaId: string | null;
}

const NONE: OrderAttribution = {
  method: "NONE",
  channel: null,
  adId: null,
  adSourceType: null,
  ctwaClidEnc: null,
  refCode: null,
  refCodeAt: null,
  touchAt: null,
  pageRef: null,
  psidEnc: null,
  wabaId: null,
};

/** شكل رمز حقيقي: حرف ورقم معًا (K7Q2) — لا رقم طلب ولا كلمة. */
export function codeLooksReal(code: string): boolean {
  return /[A-Z]/.test(code) && /\d/.test(code);
}

/** رمز غير متحقق يُعتمد فقط إذا شكله شكل رمز حقيقي. */
function codeUsable(row: TouchRow): boolean {
  if (row.codeStatus === "VALID") return true;
  if (row.codeStatus === "INVALID") return false;
  return codeLooksReal(row.refCode ?? "");
}

/**
 * إسناد طلب: بداية آخر حلقة قبل لحظة الطلب داخل المحادثة. لا لمسة (أو
 * أقدم من 28 يوم) = NONE — بلا تخمين.
 */
export async function resolveOrderAttribution(
  db: Db,
  input: { workspaceId: string; conversationId: string | null | undefined; at?: Date }
): Promise<OrderAttribution> {
  const model = touches(db);
  if (!model || !input.conversationId) return NONE;
  const at = input.at ?? new Date();
  const starts = (await model.findMany({
    where: { workspaceId: input.workspaceId, conversationId: input.conversationId, episodeStart: true, occurredAt: { lte: at } },
    orderBy: { occurredAt: "desc" },
    take: 5,
  })) as TouchRow[];
  const row = starts.find((r) => r.kind === "AD" || codeUsable(r));
  if (!row) return NONE;
  const touchAt = new Date(row.occurredAt);
  if (at.getTime() - touchAt.getTime() > MAX_ATTRIBUTION_AGE_DAYS * 24 * 3600_000) return NONE;
  if (row.kind === "AD") {
    return {
      method: "AD",
      channel: row.channel,
      adId: row.adId,
      adSourceType: row.adSourceType,
      ctwaClidEnc: row.ctwaClidEnc,
      refCode: null,
      refCodeAt: null,
      touchAt,
      pageRef: row.pageId,
      psidEnc: row.psidEnc,
      wabaId: row.wabaId,
    };
  }
  return {
    method: "CODE",
    channel: row.channel,
    adId: null,
    adSourceType: null,
    ctwaClidEnc: null,
    refCode: row.refCode,
    refCodeAt: touchAt,
    touchAt,
    pageRef: row.pageId,
    psidEnc: null,
    wabaId: null,
  };
}

/** يثبّت لقطة الإسناد على الطلب (مرة واحدة — لا تتغير بعد الإنشاء). */
export async function snapshotOrderAttribution(
  db: Db,
  order: { id: string; workspaceId: string; conversationId: string | null; createdAt?: Date | string; channelType?: string | null }
): Promise<OrderAttribution> {
  try {
    const attr = await resolveOrderAttribution(db, {
      workspaceId: order.workspaceId,
      conversationId: order.conversationId,
      at: order.createdAt ? new Date(order.createdAt) : new Date(),
    });
    const channel = attr.channel ?? (order.channelType ? channelKey(order.channelType) : null);
    await (db as unknown as { order: { update: (a: unknown) => Promise<unknown> } }).order.update({
      where: { id: order.id },
      data: {
        channel,
        attributionMethod: attr.method,
        adId: attr.adId,
        adSourceType: attr.adSourceType,
        ctwaClidEnc: attr.ctwaClidEnc,
        refCode: attr.refCode,
        refCodeAt: attr.refCodeAt,
        touchAt: attr.touchAt,
        pageRef: attr.pageRef,
        psidEnc: attr.psidEnc,
        wabaId: attr.wabaId,
      },
    });
    return { ...attr, channel };
  } catch (err) {
    log.error({ err, orderId: order.id }, "order_attribution_snapshot_failed");
    return NONE;
  }
}

/** فك تشفير مرجع حساس لحظة الإرسال للـ OMS فقط (لا يُسجّل أبدًا). */
export function revealRef(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

/** يعلّم نتيجة التحقق من رمز (من الكليبر)؛ الرمز المرفوض لا يفتح حلقة. */
export async function markCodeVerification(
  db: Db,
  touchId: string,
  result: { valid: boolean; productCode?: string | null; campaignRef?: string | null; windowDays?: number | null }
): Promise<TouchRow | null> {
  const model = touches(db);
  if (!model) return null;
  const data: Record<string, unknown> = {
    codeStatus: result.valid ? "VALID" : "INVALID",
    codeProductCode: result.productCode ?? null,
    codeCampaignRef: result.campaignRef ?? null,
    codeWindowDays: result.windowDays ?? null,
  };
  if (!result.valid) {
    data.episodeStart = false;
    const row = (await model.findFirst({ where: { id: touchId } })) as TouchRow | null;
    const updated = (await model.update({ where: { id: touchId }, data })) as TouchRow;
    // رمز مرفوض كان فاتح حلقة: الحلقة ما بدأت أصلًا — أول لمسة صالحة بعده
    // (إعلان أو رمز حقيقي) ضمن نافذته بتصير هي البداية، وإلا الطلب بيضيع بلا إسناد.
    if (row?.episodeStart) await promoteNextTouch(db, model, row);
    return updated;
  }
  if (result.valid) {
    // رمز صالح ما فتح حلقة لأنه ما شبه رمزًا (أرقام فقط): يفتحها الآن إذا ما
    // كانت حلقة مفتوحة لحظته ولا بدأت حلقة بعده.
    const row = (await model.findFirst({ where: { id: touchId } })) as TouchRow | null;
    if (row && !row.episodeStart) {
      const at = new Date(row.occurredAt);
      const settings = await getIntegrationSettings(db, row.workspaceId);
      const windowMs = settings.attributionWindowDays * 24 * 3600_000;
      const starts = (await model.findMany({
        where: { workspaceId: row.workspaceId, conversationId: row.conversationId, episodeStart: true },
        orderBy: { occurredAt: "desc" },
        take: 20,
      })) as TouchRow[];
      const before = starts.find((s) => new Date(s.occurredAt).getTime() <= at.getTime());
      const after = starts.some((s) => new Date(s.occurredAt).getTime() > at.getTime());
      const openBefore = before ? at.getTime() - new Date(before.occurredAt).getTime() < windowMs : false;
      if (!openBefore && !after) data.episodeStart = true;
    }
  }
  return (await model.update({ where: { id: touchId }, data })) as TouchRow;
}

/** بعد رفض رمز فاتح حلقة: أول لمسة صالحة لاحقة بنفس المحادثة بتفتح الحلقة. */
async function promoteNextTouch(db: Db, model: TouchModel, invalid: TouchRow): Promise<void> {
  try {
    const later = (await model.findMany({
      where: { workspaceId: invalid.workspaceId, conversationId: invalid.conversationId, occurredAt: { gt: new Date(invalid.occurredAt) } },
      orderBy: { occurredAt: "asc" },
      take: 50,
    })) as TouchRow[];
    for (const t of later) {
      if (t.episodeStart) return; // حلقة لاحقة بدأت لحالها — ما في شي يتعدّل
      if (t.kind === "AD" || codeUsable(t)) {
        await model.update({ where: { id: t.id }, data: { episodeStart: true } });
        return;
      }
    }
  } catch (err) {
    log.warn({ err, touchId: invalid.id }, "attribution_promote_failed");
  }
}
