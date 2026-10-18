import { z } from "zod";
import { AppError, NotFoundError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import { approveCampaign, createCampaign, scheduleCampaign, validateCampaign } from "@/modules/campaigns/campaign-service";
import { evaluateSegment } from "@/modules/campaigns/segment-service";
import { marketingChannelDecision } from "@/modules/campaigns/campaign-schemas";
import type { SegmentDefinition } from "@/modules/campaigns/segment-schemas";
import { getDecryptedConnection } from "./connections";
import { systemGet } from "./http";
import { emitIntegrationEvent, eventQueued } from "./outbox";
import { conversationRef } from "./format";
import { markCodeVerification, codeLooksReal } from "./attribution";
import { getIntegrationSettings } from "./settings";
import { findPii } from "./pii-guard";

/**
 * P12 — الكليبر (عقد الكليبر IN02–IN04 · LG04 · LG07):
 * - الرمز من أول رسالة ← تحقق من GET {CLIPPER}/api/v1/codes/{code} ←
 *   conversation.coded {code, channel, conversation_ref} (مرة لكل حلقة).
 * - حملة إعادة تواصل واردة POST /api/v1/retarget-campaigns ← شريحة من
 *   الموافقين فقط داخل سيستم 7 ← الكليبر يستلم أعدادًا لا أشخاصًا.
 * - النتيجة retarget.result (مؤقتة ثم نهائية بعد 72 ساعة) · opt_out.
 * الكليبر لا يرسل رسائل ولا يرى رقم زبون — الرسائل من الردود فقط.
 */

const log = childLogger("integrations.clipper");

/** لقطة: هل رمزه صالح؟ (من الكليبر) — يُستدعى من مهمة validate_attribution_code. */
export async function validateCodeTouch(db: Db, touchId: string): Promise<{ success: boolean; error?: string }> {
  const touch = (await (db as unknown as { attributionTouch?: { findFirst: (a: unknown) => Promise<unknown> } }).attributionTouch?.findFirst({
    where: { id: touchId },
  })) as
    | { id: string; workspaceId: string; conversationId: string; channel: string; refCode: string | null; codeStatus: string | null; kind: string }
    | null
    | undefined;
  if (!touch || touch.kind !== "CODE" || !touch.refCode) return { success: true };
  if (touch.codeStatus && touch.codeStatus !== "UNVERIFIED") return { success: true };
  const conn = await getDecryptedConnection(db, touch.workspaceId, "clipper");
  if (!conn || !conn.enabled || !conn.baseUrl) return { success: true }; // الكليبر غير مربوط: يبقى غير متحقق
  const res = await systemGet(conn, `/api/v1/codes/${encodeURIComponent(touch.refCode)}`);
  if (res.status === 404 || (res.ok && (res.json as { valid?: boolean } | null)?.valid === false)) {
    await markCodeVerification(db, touch.id, { valid: false });
    return { success: true };
  }
  if (!res.ok) {
    // انقطاع/5xx: المهمة تعاد (الرمز يبقى غير متحقق حتى ذلك).
    return { success: false, error: res.error ?? `HTTP ${res.status}` };
  }
  const body = (res.json ?? {}) as { valid?: boolean; product_code?: string; campaign_ref?: string; window_days?: number };
  if (body.valid !== true) {
    // رد بلا valid صريح = مش حكم: الرمز بيضل «غير متحقق» (بلا إعادة لا نهائية).
    log.warn({ touchId: touch.id }, "code_validation_ambiguous_response");
    return { success: true };
  }
  const updated = await markCodeVerification(db, touch.id, {
    valid: true,
    productCode: typeof body.product_code === "string" ? body.product_code.slice(0, 32) : null,
    campaignRef: typeof body.campaign_ref === "string" ? body.campaign_ref.slice(0, 64) : null,
    windowDays: Number.isInteger(body.window_days) ? Number(body.window_days) : null,
  });
  if (updated?.episodeStart) {
    await emitConversationCoded(db, { workspaceId: touch.workspaceId, conversationId: touch.conversationId, channel: touch.channel, code: touch.refCode, touchId: touch.id });
  }
  return { success: true };
}

export async function emitConversationCoded(
  db: Db,
  input: { workspaceId: string; conversationId: string; channel: string; code: string; touchId: string }
): Promise<number> {
  return emitIntegrationEvent(db, {
    workspaceId: input.workspaceId,
    type: "conversation.coded",
    data: { code: input.code, channel: input.channel, conversation_ref: conversationRef(input.conversationId) },
    dedupeKey: `coded:${input.touchId}`,
  });
}

/**
 * بعد التقاط لمسة رمز: إذا الكليبر مربوط → مهمة تحقق؛ وإذا لا → لا حدث
 * (ما في مستقبِل) ويبقى الرمز «غير متحقق» يُعتمد بالطلب فقط إذا شكله حقيقي.
 */
export async function afterCodeCaptured(db: Db, workspaceId: string, touchId: string): Promise<void> {
  try {
    const conn = await getDecryptedConnection(db, workspaceId, "clipper");
    if (!conn || !conn.enabled || !conn.baseUrl) return;
    const { enqueueJob } = await import("@/modules/jobs/service");
    await enqueueJob(db, {
      workspaceId,
      type: "validate_attribution_code",
      payload: { touchId },
      idempotencyKey: `code-validate:${touchId}`,
      maxAttempts: CODE_VALIDATION_MAX_ATTEMPTS,
    });
  } catch (err) {
    log.warn({ err, touchId }, "code_validation_enqueue_failed");
  }
}

/** ميزانية تحقق الرمز (≈ 35 دقيقة) قبل ما يستلمه الكنس الساعي. */
export const CODE_VALIDATION_MAX_ATTEMPTS = 8;
const CODE_SWEEP_HOURS = 72;
const CODE_SWEEP_TOUCH_DAYS = 7;

/**
 * كنس ساعي: تحقق رموز فشل لأن الكليبر كان واقف (المهمة استنفدت محاولاتها)
 * ← مهمة جديدة، طالما الرمز لسا «غير متحقق» واللمسة أحدث من 7 أيام. بلاها
 * انقطاع دقيقتين كان يخلّي الرمز غير متحقق للأبد وconversation.coded ما بيطلع.
 */
export async function sweepUnverifiedCodes(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const failed = (await db.backgroundJob.findMany({
    where: {
      workspaceId,
      type: "validate_attribution_code",
      status: "FAILED",
      finishedAt: { gte: new Date(now.getTime() - CODE_SWEEP_HOURS * 3600_000) },
    } as never,
    orderBy: { finishedAt: "desc" },
    take: 300,
  })) as Array<{ payload: unknown }>;
  const { enqueueJob } = await import("@/modules/jobs/service");
  const seen = new Set<string>();
  let n = 0;
  for (const job of failed) {
    const touchId = String((job.payload as { touchId?: unknown } | null)?.touchId ?? "");
    if (!touchId || seen.has(touchId)) continue;
    seen.add(touchId);
    const touch = (await (db as unknown as { attributionTouch?: { findFirst: (a: unknown) => Promise<unknown> } }).attributionTouch?.findFirst({
      where: { id: touchId, workspaceId },
    })) as { codeStatus: string | null; occurredAt: Date | string; kind: string } | null | undefined;
    if (!touch || touch.kind !== "CODE") continue;
    if (touch.codeStatus && touch.codeStatus !== "UNVERIFIED") continue;
    if (now.getTime() - new Date(touch.occurredAt).getTime() > CODE_SWEEP_TOUCH_DAYS * 24 * 3600_000) continue;
    const res = await enqueueJob(db, {
      workspaceId,
      type: "validate_attribution_code",
      payload: { touchId },
      idempotencyKey: `code-validate:${touchId}`,
      maxAttempts: CODE_VALIDATION_MAX_ATTEMPTS,
    }).catch(() => null);
    if (res && !res.deduplicated) n += 1;
    if (n >= 100) break;
  }
  if (n > 0) log.info({ workspaceId, requeued: n }, "code_validation_sweep_requeued");
  return n;
}

// ─────────────────────────── حملات إعادة التواصل ───────────────────────────

export const SEGMENT_KINDS = ["messaged_no_order", "cancelled_before_shipping", "repeat_product"] as const;

export const retargetRequestSchema = z.object({
  // نفس حارس البيانات الي بيمر منه retarget.result: مرجع بيشبه رقم هاتف كان
  // رح ينقبل هون وينمنع حدث نتيجته للأبد بصمت — منرفضه من الأول (422).
  external_ref: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => findPii({ external_ref: v }).length === 0, { message: "external_ref فيه سلسلة أرقام بشكل رقم هاتف" }),
  channel: z.enum(["whatsapp", "messenger", "instagram", "telegram"]),
  segment: z.object({
    kind: z.enum(SEGMENT_KINDS),
    code_prefix: z.string().regex(/^[A-Za-z0-9]{1,12}$/).nullable().optional(),
    days: z.tuple([z.number().int().min(0).max(90), z.number().int().min(1).max(365)]).optional(),
  }),
  template_ref: z.string().regex(/^[a-z0-9_]{1,120}$/),
  template_language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).optional(),
  frequency_cap: z.object({ per_person_days: z.number().int().min(1).max(90) }).optional(),
  opt_in_required: z.literal(true),
  approved_by: z.string().min(1).max(64),
  approved_at: z.string().datetime({ offset: true }),
});
export type RetargetRequest = z.infer<typeof retargetRequestSchema>;

const CHANNEL_TYPE: Record<RetargetRequest["channel"], string> = {
  whatsapp: "WHATSAPP",
  messenger: "FACEBOOK",
  instagram: "INSTAGRAM",
  telegram: "TELEGRAM",
};

/** حصر الشريحة بمنتج (من مسدودة إعادة تواصل خارجية بـ product_code): معرّفه بالردود + رمزه. */
export interface RetargetProductScope {
  productId: string;
  productCode: string;
}

/** تعريف الشريحة من نوع الكليبر — دائمًا مقصور على الموافقين + سقف التكرار. */
export function segmentForRetarget(req: RetargetRequest, product?: RetargetProductScope | null): SegmentDefinition {
  const [minD, maxD] = req.segment.days ?? (req.segment.kind === "repeat_product" ? [30, 45] : [1, 7]);
  const conditions: SegmentDefinition["conditions"] = [
    { field: "customer.marketingConsent", op: "EQ", value: "OPTED_IN" },
  ];
  if (req.segment.kind === "messaged_no_order") {
    const prefix = req.segment.code_prefix ? req.segment.code_prefix.toUpperCase() : null;
    conditions.push({
      field: "attribution.code",
      op: prefix ? "PREFIX" : "ANY",
      ...(prefix ? { value: prefix } : {}),
      minDays: minD,
      maxDays: Math.min(maxD, 90),
      // رمز الكليبر لهالمنتج بالذات (من تحقق الرمز) — مش أي رمز.
      ...(product ? { productCode: product.productCode } : {}),
    });
    conditions.push({ field: "orders.noneWithinDays", op: "EQ", days: Math.max(maxD, 1) });
  } else if (req.segment.kind === "cancelled_before_shipping") {
    conditions.push({
      field: "orders.statusBetweenDays",
      op: "IN",
      value: ["CANCELLED"],
      minDays: minD,
      maxDays: Math.max(maxD, 1),
      ...(product ? { productId: product.productId } : {}),
    });
  } else {
    conditions.push({
      field: "orders.statusBetweenDays",
      op: "IN",
      value: ["DELIVERED"],
      minDays: minD,
      maxDays: Math.max(maxD, 1),
      ...(product ? { productId: product.productId } : {}),
    });
  }
  const cap = req.frequency_cap?.per_person_days;
  if (cap) conditions.push({ field: "campaign.notReceivedWithinDays", op: "EQ", days: cap });
  return { version: 1, match: "ALL", conditions };
}

/** حالة الحملة بلغة عقد الكليبر. */
export function retargetStatus(status: string, approvedAt: unknown): "pending_approval" | "queued" | "running" | "completed" | "cancelled" | "failed" {
  switch (status) {
    case "RUNNING":
    case "PAUSED":
      return "running";
    case "COMPLETED":
      return "completed";
    case "CANCELLED":
      return "cancelled";
    case "FAILED":
      return "failed";
    case "SCHEDULED":
      return "queued";
    default:
      return approvedAt ? "queued" : "pending_approval";
  }
}

const SYSTEM_ACTOR = "system:clipper";

export interface RetargetResponse {
  campaign_id: string;
  status: ReturnType<typeof retargetStatus>;
  eligible_count: number;
}

export function retargetCampaignId(campaignId: string): string {
  return `rep_rt_${campaignId}`;
}

/** يحوّل rep_rt_<id> لمعرّف داخلي (أو null إذا الشكل غلط). */
export function parseRetargetCampaignId(publicId: string): string | null {
  const m = publicId.match(/^rep_rt_([a-z0-9]{8,40})$/);
  return m ? m[1] : null;
}

type CampaignRow = { id: string; workspaceId: string; status: string; approvedAt: unknown; segmentId: string; channelType: string; externalSystem: string | null; externalRef: string | null };

async function eligibleCountFor(db: Db, workspaceId: string, campaign: CampaignRow): Promise<number> {
  const seg = await db.audienceSegment.findUnique({ where: { id: campaign.segmentId } });
  if (!seg) return 0;
  const r = await evaluateSegment(db, { workspaceId, definition: seg.definition, channelType: campaign.channelType });
  return r.eligible.length;
}

export interface RetargetSpec {
  externalRef: string;
  channel: RetargetRequest["channel"];
  segment: RetargetRequest["segment"];
  templateRef: string;
  templateLanguage?: string;
  frequencyCapDays?: number;
  approvedBy: string;
  note?: string | null;
  /** حصر بمنتج من المواصفة الواردة — نفس الحصر وقت التكوين ووقت الاعتماد. */
  product?: RetargetProductScope | null;
}

/**
 * يبني شريحة + حملة (READY بانتظار الاعتماد) من مواصفة إعادة تواصل —
 * مسار موحّد بغض النظر عن المصدر. الرسائل لا تطلع إلا بعد اعتماد حملات
 * سيستم 7 القائم (campaigns.approve) أو ثقة صريحة باعتماد الكليبر.
 */
export async function buildRetargetCampaign(
  db: Db,
  input: { workspaceId: string; source: string; actor: string; spec: RetargetSpec; idempotencyKey?: string | null }
): Promise<{ campaignId: string }> {
  const spec = input.spec;
  // إعادة التواصل بقالب واتساب معتمد بس: العقد بيبعت template_ref، وقناة
  // بلا قوالب (تيليغرام) كانت رح تبعت للزبون نص «قالب واتساب المعتمد: …» حرفيًا.
  if (spec.channel !== "whatsapp") {
    throw new AppError("إعادة التواصل بقالب واتساب معتمد بس — هالقناة ما إلها قوالب", 422, "RETARGET_WHATSAPP_ONLY");
  }
  const channelType = CHANNEL_TYPE[spec.channel];
  const decision = marketingChannelDecision(channelType);
  if (!decision.allowed) {
    throw new AppError(`القناة ${spec.channel} ما بتدعم حملات تسويقية رسمية`, 422, decision.reason);
  }
  const channel = await db.channel.findFirst({
    where: { workspaceId: input.workspaceId, type: channelType as never, status: "CONNECTED" },
    select: { id: true },
  });
  if (!channel) throw new AppError(`ما في قناة ${spec.channel} متصلة`, 422, "CHANNEL_NOT_CONNECTED");
  const definition = segmentForRetarget(
    {
      external_ref: spec.externalRef,
      channel: spec.channel,
      segment: spec.segment,
      template_ref: spec.templateRef,
      ...(spec.frequencyCapDays ? { frequency_cap: { per_person_days: spec.frequencyCapDays } } : {}),
      opt_in_required: true,
      approved_by: spec.approvedBy,
      approved_at: new Date().toISOString(),
    },
    spec.product ?? null
  );
  const label = input.source === "clipper" ? "كليبر" : "الوكيل الذكي";  const segment = (await db.audienceSegment.create({
    data: {
      workspaceId: input.workspaceId,
      name: `${label} · ${spec.externalRef}`.slice(0, 120),
      description: `شريحة ${spec.segment.kind}${spec.product ? ` · منتج ${spec.product.productCode}` : ""} — مصدرها ${label}`,
      definition: definition as never,
      createdBy: input.actor,
    },
  })) as { id: string };
  const ctx = { userId: input.actor, workspaceId: input.workspaceId };
  const { campaign } = await createCampaign(db, ctx, {
    name: `إعادة تواصل · ${label} ${spec.externalRef}`.slice(0, 120),
    description: (spec.note ?? `طلب ${label} ${spec.externalRef} — اعتمده ${spec.approvedBy}`).slice(0, 500),
    segmentId: segment.id,
    channelType,
    channelId: channel.id,
    content: {
      // نص للمراجعة البشرية — الإرسال الفعلي بالقالب المعتمد بميتا فقط.
      text: `قالب واتساب المعتمد: ${spec.templateRef}`,
      ...(channelType === "WHATSAPP" ? { templateName: spec.templateRef, templateLanguage: spec.templateLanguage ?? "ar" } : {}),
    },
  });
  try {
    await db.campaign.update({
      where: { id: campaign.id },
      data: {
        source: input.source,
        externalSystem: input.source,
        externalRef: spec.externalRef,
        ...(input.idempotencyKey ? { externalIdempotencyKey: input.idempotencyKey } : {}),
      } as never,
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002" && input.idempotencyKey) {
      // طلبين متزامنين بنفس المفتاح: الأول ربح — هالنسخة بتنلغى (ما بتنبعت أبدًا).
      await db.campaign
        .update({ where: { id: campaign.id }, data: { status: "CANCELLED", description: "نسخة مكررة من طلب متزامن — أُلغيت تلقائيًا" } as never })
        .catch(() => undefined);
      throw new AppError("طلب متزامن بنفس Idempotency-Key", 409, "IDEMPOTENCY_RACE");
    }
    throw err;
  }
  await validateCampaign(db, ctx, campaign.id);
  return { campaignId: campaign.id };
}

/**
 * POST /api/v1/retarget-campaigns — حملة واردة من الكليبر.
 * Idempotency-Key إلزامي: نفس المفتاح = نفس الحملة (لا تكرار بإعادة المحاولة).
 * الإرسال الفعلي: باعتماد صاحب الحساب هنا (افتراضي)، أو تلقائيًا إذا فعّل
 * «اعتماد الكليبر يكفي» بالإعدادات.
 */
export async function createRetargetCampaign(
  db: Db,
  input: { workspaceId: string; idempotencyKey: string; body: unknown }
): Promise<{ created: boolean; response: RetargetResponse }> {
  const key = input.idempotencyKey.trim();
  if (!/^[A-Za-z0-9_\-:.]{4,120}$/.test(key)) throw new AppError("Idempotency-Key إلزامي", 422, "IDEMPOTENCY_KEY_REQUIRED");
  const existing = (await db.campaign.findFirst({
    where: { workspaceId: input.workspaceId, externalIdempotencyKey: key },
  } as never)) as CampaignRow | null;
  if (existing) {
    return {
      created: false,
      response: {
        campaign_id: retargetCampaignId(existing.id),
        status: retargetStatus(existing.status, existing.approvedAt),
        eligible_count: await eligibleCountFor(db, input.workspaceId, existing),
      },
    };
  }

  const req = retargetRequestSchema.parse(input.body);
  let campaignId: string;
  try {
    ({ campaignId } = await buildRetargetCampaign(db, {
      workspaceId: input.workspaceId,
      source: "clipper",
      actor: SYSTEM_ACTOR,
      idempotencyKey: key,
      spec: {
        externalRef: req.external_ref,
        channel: req.channel,
        segment: req.segment,
        templateRef: req.template_ref,
        templateLanguage: req.template_language,
        frequencyCapDays: req.frequency_cap?.per_person_days,
        approvedBy: req.approved_by,
      },
    }));
  } catch (err) {
    if (err instanceof AppError && err.code === "IDEMPOTENCY_RACE") {
      const winner = (await db.campaign.findFirst({
        where: { workspaceId: input.workspaceId, externalIdempotencyKey: key },
      } as never)) as CampaignRow | null;
      if (winner) {
        return {
          created: false,
          response: {
            campaign_id: retargetCampaignId(winner.id),
            status: retargetStatus(winner.status, winner.approvedAt),
            eligible_count: await eligibleCountFor(db, input.workspaceId, winner),
          },
        };
      }
    }
    throw err;
  }

  const settings = await getIntegrationSettings(db, input.workspaceId);
  const ctx = { userId: SYSTEM_ACTOR, workspaceId: input.workspaceId };
  if (settings.trustClipperApprovals) {
    await approveCampaign(db, { ...ctx, can: () => true }, campaignId);
    await scheduleCampaign(db, ctx, campaignId, {});
  }
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    userId: null,
    action: "integration.retarget_campaign_received",
    entityType: "Campaign",
    entityId: campaignId,
    metadata: { externalRef: req.external_ref, kind: req.segment.kind, channel: req.channel, autoApproved: settings.trustClipperApprovals },
  });
  const fresh = (await db.campaign.findUnique({ where: { id: campaignId } })) as unknown as CampaignRow;
  return {
    created: true,
    response: {
      campaign_id: retargetCampaignId(campaignId),
      status: retargetStatus(fresh.status, fresh.approvedAt),
      eligible_count: await eligibleCountFor(db, input.workspaceId, fresh),
    },
  };
}

export async function getRetargetCampaign(db: Db, workspaceId: string, publicId: string) {
  const id = parseRetargetCampaignId(publicId);
  if (!id) throw new NotFoundError("Campaign");
  const campaign = (await db.campaign.findUnique({ where: { id } })) as unknown as CampaignRow | null;
  if (!campaign || campaign.workspaceId !== workspaceId || campaign.externalSystem !== "clipper") throw new NotFoundError("Campaign");
  const counts = await retargetCounts(db, campaign.id);
  return {
    campaign_id: retargetCampaignId(campaign.id),
    external_ref: campaign.externalRef,
    status: retargetStatus(campaign.status, campaign.approvedAt),
    counts,
  };
}

/** أعداد نتيجة الحملة (لا أشخاص): وصل · قرأ · رد · طلب · ألغى · فشل — بخمس قراءات مجمّعة. */
export async function retargetCounts(db: Db, campaignId: string) {
  const recipients = (await db.campaignRecipient.findMany({
    where: { campaignId },
    select: { customerId: true, status: true, messageId: true, sentAt: true, workspaceId: true },
  })) as Array<{ customerId: string; status: string; messageId: string | null; sentAt: Date | string | null; workspaceId: string }>;
  const sent = recipients.filter((r) => r.status === "SENT" && r.sentAt);
  const workspaceId = recipients[0]?.workspaceId;
  const counts = {
    eligible: recipients.length,
    sent: sent.length,
    delivered: 0,
    read: 0,
    replied: 0,
    ordered: 0,
    opted_out: 0,
    failed: recipients.filter((r) => r.status === "FAILED").length,
    excluded: recipients.filter((r) => r.status === "EXCLUDED" || r.status === "CANCELLED").length,
  };
  if (!sent.length || !workspaceId) return counts;

  const sentAt = new Map(sent.map((r) => [r.customerId, new Date(r.sentAt as string | Date).getTime()]));
  const ids = [...sentAt.keys()];
  // OCR-2026-10-16: Math.min(...values) انفجر المكدس بما فوق آلاف المستلمين —
  // حلقة تدقيق بسيطة بدل الانتشار (دفعات الحملات الكبيرة).
  let minTs = Number.POSITIVE_INFINITY;
  for (const v of sentAt.values()) if (v < minTs) minTs = v;
  if (!Number.isFinite(minTs)) minTs = Date.now();
  const minSince = new Date(minTs);

  const messageIds = sent.map((r) => r.messageId).filter((v): v is string => Boolean(v));
  const [msgs, convs, orders, customers] = await Promise.all([
    messageIds.length
      ? (db.message.findMany({ where: { id: { in: messageIds } }, select: { id: true, deliveryStatus: true } }) as Promise<Array<{ id: string; deliveryStatus: string }>>)
      : Promise.resolve([] as Array<{ id: string; deliveryStatus: string }>),
    db.conversation.findMany({ where: { workspaceId, customerId: { in: ids } }, select: { id: true, customerId: true } }) as Promise<Array<{ id: string; customerId: string }>>,
    db.order.findMany({ where: { workspaceId, customerId: { in: ids }, createdAt: { gt: minSince } }, select: { customerId: true, createdAt: true } }) as Promise<Array<{ customerId: string; createdAt: Date | string }>>,
    db.customer.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, marketingOptOutAt: true } }) as Promise<Array<{ id: string; marketingOptOutAt: Date | string | null }>>,
  ]);
  for (const m of msgs) {
    if (m.deliveryStatus === "DELIVERED" || m.deliveryStatus === "READ") counts.delivered += 1;
    if (m.deliveryStatus === "READ") counts.read += 1;
  }
  const customerByConv = new Map(convs.map((c) => [c.id, c.customerId]));
  const inbound = convs.length
    ? ((await db.message.findMany({
        // رد الزبون بس: ملاحظة داخلية (بتنحفظ INBOUND) أو رسالة نظام مش رد.
        where: {
          workspaceId,
          direction: "INBOUND",
          senderType: "CUSTOMER",
          isNote: false,
          deletedAt: null,
          conversationId: { in: convs.map((c) => c.id) },
          createdAt: { gt: minSince },
        },
        select: { conversationId: true, createdAt: true },
      })) as Array<{ conversationId: string; createdAt: Date | string }>)
    : [];
  const repliedSet = new Set<string>();
  for (const m of inbound) {
    const cid = customerByConv.get(m.conversationId);
    if (cid && new Date(m.createdAt).getTime() > (sentAt.get(cid) ?? Infinity)) repliedSet.add(cid);
  }
  const orderedSet = new Set<string>();
  for (const o of orders) {
    if (new Date(o.createdAt).getTime() > (sentAt.get(o.customerId) ?? Infinity)) orderedSet.add(o.customerId);
  }
  for (const c of customers) {
    if (c.marketingOptOutAt && new Date(c.marketingOptOutAt).getTime() > (sentAt.get(c.id) ?? Infinity)) counts.opted_out += 1;
  }
  counts.replied = repliedSet.size;
  counts.ordered = orderedSet.size;
  return counts;
}

/** يرسل retarget.result للكليبر (مؤقتة عند الانتهاء/الإلغاء · نهائية بعد 72 ساعة). */
export async function emitRetargetResult(db: Db, campaignId: string, final: boolean): Promise<boolean> {
  try {
    const campaign = (await db.campaign.findUnique({ where: { id: campaignId } })) as unknown as
      | (CampaignRow & { resultsSentAt?: unknown; finalResultsSentAt?: unknown })
      | null;
    if (!campaign || campaign.externalSystem !== "clipper" || !campaign.externalRef) return false;
    const counts = await retargetCounts(db, campaignId);
    const n = await emitIntegrationEvent(db, {
      workspaceId: campaign.workspaceId,
      type: "retarget.result",
      data: {
        campaign_id: retargetCampaignId(campaign.id),
        external_ref: campaign.externalRef,
        status: retargetStatus(campaign.status, campaign.approvedAt),
        final,
        counts,
      },
      dedupeKey: `${campaign.id}:${final ? "final" : `interim:${campaign.status}`}`,
    });
    // «انبعت» بس إذا الحدث فعلًا بصندوق الصادر (جديد أو من محاولة سابقة) —
    // الكليبر موقوف = بنحاول بالساعة الجاية بدل ما نعلّمها منسية للأبد.
    const queued = n > 0 || (await eventQueued(db, campaign.workspaceId, "clipper", "retarget.result", `${campaign.id}:${final ? "final" : `interim:${campaign.status}`}`));
    if (!queued) return false;
    await db.campaign.update({
      where: { id: campaignId },
      data: (final ? { finalResultsSentAt: new Date() } : { resultsSentAt: new Date() }) as never,
    });
    return n > 0; // true = انكتب جديد هالمرة (للعدّ بالمجدول)
  } catch (err) {
    log.error({ err, campaignId }, "retarget_result_emit_failed");
    return false;
  }
}

/** opt_out للكليبر — فقط لزبون جه برمز (تقليل البيانات: غيره لا يعني الكليبر). */
export async function emitOptOutIfCoded(
  db: Db,
  input: { workspaceId: string; customerId: string; conversationId: string | null; channel: string }
): Promise<number> {
  const touch = (await (db as unknown as { attributionTouch?: { findFirst: (a: unknown) => Promise<unknown> } }).attributionTouch?.findFirst({
    where: { workspaceId: input.workspaceId, customerId: input.customerId, kind: "CODE", codeStatus: { in: ["VALID", "UNVERIFIED"] } },
    orderBy: { occurredAt: "desc" },
  })) as { refCode: string | null; conversationId: string; channel: string; codeStatus: string | null } | null | undefined;
  if (!touch?.refCode) return 0;
  if (touch.codeStatus !== "VALID" && !codeLooksReal(touch.refCode)) return 0;
  // القناة والمحادثة من نفس المصدر: محادثة الإلغاء إذا معروفة بقناتها، وإلا محادثة الرمز.
  const useInput = Boolean(input.conversationId && input.channel);
  const conversationId = useInput ? input.conversationId! : touch.conversationId;
  const channel = useInput ? input.channel : touch.channel;
  return emitIntegrationEvent(db, {
    workspaceId: input.workspaceId,
    type: "opt_out",
    data: { channel, conversation_ref: conversationRef(conversationId), code: touch.refCode },
    dedupeKey: `optout:${input.customerId}:${new Date().toISOString().slice(0, 10)}`,
  });
}
