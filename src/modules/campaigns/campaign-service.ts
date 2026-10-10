import type { Prisma } from "@prisma/client";
import type { Db } from "@/modules/customers/service";
import { AppError, AuthorizationError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { enqueueJob } from "@/modules/jobs/service";
import type { Permission } from "@/modules/rbac/permissions";
import { evaluateSegment } from "./segment-service";
import { campaignRequiresTemplate } from "./eligibility";
import {
  campaignContentSchema,
  campaignCreateSchema,
  canTransition,
  marketingChannelDecision,
  type CampaignCreateInput,
} from "./campaign-schemas";

/**
 * P9 — دورة حياة الحملة: انتقالات مسماة فقط، لقطة محتوى append-only،
 * وموافقة مثبتة على (إصدار المحتوى + بصمة الجمهور المتوقع) — أي تغيير
 * بعد الاعتماد يُبطل الموافقة ويعيد التحقق. كل قراءة/كتابة مملوكة للمساحة.
 */

export type CampaignRow = Record<string, unknown>;

async function addCampaignEvent(
  db: Db,
  workspaceId: string,
  campaignId: string,
  type: string,
  opts: { actorUserId?: string | null; reason?: string | null; count?: number } = {}
) {
  await (db as unknown as {
    campaignEvent: { create: (a: unknown) => Promise<unknown> };
  }).campaignEvent.create({
    data: {
      workspaceId,
      campaignId,
      type: type as never,
      actorUserId: opts.actorUserId ?? null,
      reason: opts.reason ?? null,
      count: opts.count ?? 0,
      payload: {},
    },
  } as never).catch(() => {});
}

/** بصمة الجمهور المتوقع: أعداد + شرط القناة (بلا بيانات شخصية). */
async function audienceHash(db: Db, workspaceId: string, segmentId: string, channelType: string): Promise<string> {
  const r = await evaluateSegment(db, { workspaceId, definition: (await db.audienceSegment.findUnique({ where: { id: segmentId } }))?.definition, channelType });
  return `v1:${channelType}:e${r.eligible.length}:x${r.excludedCount}`;
}

export async function createCampaign(db: Db, ctx: { userId: string; workspaceId: string }, input: unknown) {
  const parsed = campaignCreateSchema.safeParse(input);
  if (!parsed.success) throw new AppError("بيانات حملة غير صالحة", 422, "VALIDATION_ERROR");
  const data = parsed.data;

  const decision = marketingChannelDecision(data.channelType);
  if (!decision.allowed) {
    // المسار غير مدعوم رسميًا — يُمنع بدل تقليده (موثق لكل قناة).
    throw new AppError(`القناة ${data.channelType} لا تدعم حملات تسويقية مباشرة`, 422, decision.reason);
  }
  const segment = await db.audienceSegment.findUnique({ where: { id: data.segmentId } });
  if (!segment || segment.workspaceId !== ctx.workspaceId) throw new NotFoundError("Segment");

  if (campaignRequiresTemplate(data.channelType) && !data.content.templateName) {
    throw new AppError("حملات WhatsApp تتطلب قالبًا معتمدًا (اسم + لغة)", 422, "TEMPLATE_REQUIRED");
  }

  const campaign = await (db as unknown as {
    campaign: { create: (a: unknown) => Promise<CampaignRow> };
  }).campaign.create({
    data: {
      workspaceId: ctx.workspaceId,
      segmentId: data.segmentId,
      name: data.name,
      description: data.description ?? null,
      channelType: data.channelType,
      channelId: data.channelId ?? null,
      timezone: data.timezone,
      ratePerMinute: data.ratePerMinute,
      status: "DRAFT",
      createdBy: ctx.userId,
    } as never,
  });
  const version = await (db as unknown as {
    campaignContentVersion: { create: (a: unknown) => Promise<unknown> };
  }).campaignContentVersion.create({
    data: {
      workspaceId: ctx.workspaceId,
      campaignId: String(campaign.id),
      version: 1,
      text: data.content.text,
      templateName: data.content.templateName ?? null,
      templateLanguage: data.content.templateLanguage ?? null,
      templateVariables: (data.content.templateVariables ?? {}) as never,
      status: "DRAFT",
      createdBy: ctx.userId,
    } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "campaign.created",
    entityType: "Campaign",
    entityId: String(campaign.id),
    metadata: { channelType: data.channelType, segmentId: data.segmentId, version: 1 },
  });
  await addCampaignEvent(db, ctx.workspaceId, String(campaign.id), "CREATED", { actorUserId: ctx.userId });
  const campaignId = String((campaign as { id: unknown }).id);
  const versionId = String((version as { id: unknown }).id);
  return { campaign: { id: campaignId }, version: { id: versionId } };
}

export async function updateCampaignDraft(db: Db, ctx: { userId: string; workspaceId: string }, campaignId: string, input: unknown) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== ctx.workspaceId) throw new NotFoundError("Campaign");
  if (!["DRAFT", "VALIDATING", "READY", "SCHEDULED"].includes(campaign.status)) {
    throw new AppError("لا يمكن تعديل حملة في هذه الحالة", 422, "NOT_EDITABLE");
  }
  const patch = (input ?? {}) as Record<string, unknown>;
  const content = patch.content ? campaignContentSchema.safeParse(patch.content) : null;
  if (patch.content && !content?.success) throw new AppError("محتوى غير صالح", 422, "VALIDATION_ERROR");

  const data: Record<string, unknown> = {};
  for (const k of ["name", "description", "channelId", "timezone", "ratePerMinute"]) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  if (Object.keys(data).length) {
    await (db as unknown as {
      campaign: { update: (a: unknown) => Promise<unknown> };
    }).campaign.update({ where: { id: campaignId }, data: data as never });
  }
  if (content?.success) {
    // append-only: نسخة جديدة، والموافقة السابقة تسقط (contentVersionId → null)
    const last = await (db as unknown as {
      campaignContentVersion: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> };
    }).campaignContentVersion.findFirst({ where: { campaignId }, orderBy: { version: "desc" } });
    const nextVersion = Number(last?.version ?? 0) + 1;
    await (db as unknown as {
      campaignContentVersion: { create: (a: unknown) => Promise<unknown> };
    }).campaignContentVersion.create({
      data: {
        workspaceId: ctx.workspaceId,
        campaignId,
        version: nextVersion,
        text: content.data.text,
        templateName: content.data.templateName ?? null,
        templateLanguage: content.data.templateLanguage ?? null,
        templateVariables: (content.data.templateVariables ?? {}) as never,
        status: "DRAFT",
        createdBy: ctx.userId,
      } as never,
    });
    await (db as unknown as {
      campaign: { update: (a: unknown) => Promise<unknown> };
    }).campaign.update({ where: { id: campaignId }, data: { contentVersionId: null, approvalAudienceHash: null, status: "DRAFT" } as never });
  }
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "campaign.updated",
    entityType: "Campaign",
    entityId: campaignId,
    metadata: { fields: Object.keys(patch) },
  });
  return { ok: true };
}

/** التحقق قبل النشر: قناة+قالب+شريحة+جمهور محسوب — يرفع الحالة إلى READY. */
export async function validateCampaign(db: Db, ctx: { userId: string; workspaceId: string }, campaignId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== ctx.workspaceId) throw new NotFoundError("Campaign");
  if (!["DRAFT", "VALIDATING"].includes(campaign.status)) throw new AppError("حالة غير قابلة للتحقق", 422, "INVALID_TRANSITION");

  const decision = marketingChannelDecision(campaign.channelType);
  if (!decision.allowed) throw new AppError("قناة غير مدعومة", 422, decision.reason);

  const segment = await db.audienceSegment.findUnique({ where: { id: campaign.segmentId } });
  if (!segment || segment.workspaceId !== ctx.workspaceId || !segment.isActive) {
    throw new AppError("الشريحة غير موجودة أو غير نشطة", 422, "SEGMENT_INVALID");
  }

  const versions = await (db as unknown as {
    campaignContentVersion: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
  }).campaignContentVersion.findMany({ where: { campaignId }, orderBy: { version: "desc" }, take: 1 });
  const latest = versions[0];
  if (!latest) throw new AppError("لا يوجد محتوى", 422, "NO_CONTENT");
  if (campaignRequiresTemplate(campaign.channelType) && !latest.templateName) {
    throw new AppError("حملات WhatsApp تتطلب قالبًا معتمدًا", 422, "TEMPLATE_REQUIRED");
  }

  // القناة يجب أن تكون متصلة بجهة حساب (توكن) — نتحقق بالحالة فقط لا بالمفتاح.
  if (campaign.channelId) {
    const channel = await db.channel.findUnique({ where: { id: campaign.channelId } });
    if (!channel || channel.workspaceId !== ctx.workspaceId || channel.type !== campaign.channelType) {
      throw new AppError("قناة غير صالحة", 422, "CHANNEL_INVALID");
    }
    if (channel.status !== "CONNECTED") throw new AppError("القناة غير متصلة", 422, "CHANNEL_NOT_CONNECTED");
  }

  const hash = await audienceHash(db, ctx.workspaceId, campaign.segmentId, campaign.channelType);
  await (db as unknown as {
    campaign: { update: (a: unknown) => Promise<unknown> };
  }).campaign.update({
    where: { id: campaignId },
    data: { status: "READY", approvalAudienceHash: hash } as never,
  });
  await addCampaignEvent(db, ctx.workspaceId, campaignId, "VALIDATED", { actorUserId: ctx.userId });
  return { ok: true, audienceHash: hash };
}

/** اعتماد المحتوى: يثبّت أحدث إصدار (لقطة) — صلاحية campaigns.approve. */
export async function approveCampaign(db: Db, ctx: { userId: string; workspaceId: string; can: (p: Permission) => boolean }, campaignId: string) {
  if (!ctx.can("campaigns.approve")) throw new AuthorizationError("صلاحية campaigns.approve مطلوبة");
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== ctx.workspaceId) throw new NotFoundError("Campaign");
  if (!["READY"].includes(campaign.status)) throw new AppError("الاعتماد يتطلب حالة READY", 422, "INVALID_TRANSITION");
  const versions = await (db as unknown as {
    campaignContentVersion: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
  }).campaignContentVersion.findMany({ where: { campaignId }, orderBy: { version: "desc" }, take: 1 });
  const latest = versions[0];
  if (!latest) throw new AppError("لا يوجد محتوى للاعتماد", 422, "NO_CONTENT");
  await (db as unknown as {
    campaignContentVersion: { update: (a: unknown) => Promise<unknown> };
  }).campaignContentVersion.update({
    where: { id: String(latest.id) },
    data: { status: "APPROVED", approvedBy: ctx.userId, approvedAt: new Date() } as never,
  });
  await (db as unknown as {
    campaign: { update: (a: unknown) => Promise<unknown> };
  }).campaign.update({
    where: { id: campaignId },
    data: { contentVersionId: String(latest.id), approvedBy: ctx.userId, approvedAt: new Date() } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "campaign.content_approved",
    entityType: "Campaign",
    entityId: campaignId,
    metadata: { version: Number(latest.version) },
  });
  await addCampaignEvent(db, ctx.workspaceId, campaignId, "CONTENT_APPROVED", { actorUserId: ctx.userId });
  return { ok: true, version: Number(latest.version) };
}

/** الجدولة: تتحقق أن الحملة معتمدة ثم تضع مهمة بدء durable. */
export async function scheduleCampaign(db: Db, ctx: { userId: string; workspaceId: string }, campaignId: string, input: { scheduledAt?: string; timezone?: string }) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== ctx.workspaceId) throw new NotFoundError("Campaign");
  // READY: جدولة أولى. SCHEDULED: إعادة جدولة مقبولة (نفس مفتاح idempotency
  // للمهمة — بلا تضاعف). غير ذلك انتقال غير مسموح.
  if (!["READY", "SCHEDULED"].includes(campaign.status)) throw new AppError("الجدولة تتطلب حالة READY (معتمدة)", 422, "INVALID_TRANSITION");
  if (!campaign.contentVersionId || !campaign.approvedAt) throw new AppError("المحتوى غير معتمد", 422, "NOT_APPROVED");
  if (campaign.approvalAudienceHash) {
    // إعادة التحقق: تغير الجمهور بعد الاعتماد → يجب إعادة VALIDATING.
    const hash = await audienceHash(db, ctx.workspaceId, campaign.segmentId, campaign.channelType);
    if (hash !== campaign.approvalAudienceHash) {
      await (db as unknown as {
        campaign: { update: (a: unknown) => Promise<unknown> };
      }).campaign.update({ where: { id: campaignId }, data: { status: "VALIDATING", approvalAudienceHash: null } as never });
      throw new AppError("تغير الجمهور بعد الاعتماد — أعد التحقق والموافقة", 422, "AUDIENCE_CHANGED");
    }
  }
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  if (Number.isNaN(scheduledAt.getTime())) throw new AppError("وقت جدولة غير صالح", 422, "INVALID_SCHEDULE");
  await (db as unknown as {
    campaign: { update: (a: unknown) => Promise<unknown> };
  }).campaign.update({
    where: { id: campaignId },
    data: { status: "SCHEDULED", scheduledAt, ...(input.timezone ? { timezone: input.timezone } : {}) } as never,
  });
  await enqueueJob(db, {
    workspaceId: ctx.workspaceId,
    type: "run_campaign",
    payload: { campaignId },
    runAfter: scheduledAt,
    idempotencyKey: `campaign:${campaignId}:run`,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "campaign.scheduled",
    entityType: "Campaign",
    entityId: campaignId,
    metadata: { scheduledAt: scheduledAt.toISOString() },
  });
  await addCampaignEvent(db, ctx.workspaceId, campaignId, "SCHEDULED", { actorUserId: ctx.userId });
  return { ok: true, scheduledAt: scheduledAt.toISOString() };
}

async function transition(db: Db, workspaceId: string, campaignId: string, to: string, reason?: string | null, actorUserId?: string | null) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== workspaceId) throw new NotFoundError("Campaign");
  if (!canTransition(campaign.status, to)) {
    throw new AppError(`انتقال غير مسموح: ${campaign.status} → ${to}`, 422, "INVALID_TRANSITION");
  }
  const data: Record<string, unknown> = { status: to };
  if (to === "CANCELLED") { data.cancelledAt = new Date(); data.cancelReason = reason ?? null; }
  if (to === "RUNNING" && campaign.status === "PAUSED") { /* استئناف */ }
  await (db as unknown as {
    campaign: { update: (a: unknown) => Promise<unknown> };
  }).campaign.update({ where: { id: campaignId }, data: data as never });
  const eventType = to === "PAUSED" ? "PAUSED" : to === "RUNNING" && campaign.status === "PAUSED" ? "RESUMED" : to;
  await addCampaignEvent(db, workspaceId, campaignId, eventType, { actorUserId, reason });
  await recordAudit(db, {
    workspaceId,
    userId: actorUserId ?? null,
    action: `campaign.${eventType.toLowerCase()}`,
    entityType: "Campaign",
    entityId: campaignId,
    metadata: { reason: reason ?? null },
  });
  return { ok: true, status: to };
}

export const pauseCampaign = (db: Db, ctx: { userId: string; workspaceId: string }, id: string) =>
  transition(db, ctx.workspaceId, id, "PAUSED", null, ctx.userId);
export const resumeCampaign = (db: Db, ctx: { userId: string; workspaceId: string }, id: string) =>
  transition(db, ctx.workspaceId, id, "RUNNING", null, ctx.userId);
export const cancelCampaign = (db: Db, ctx: { userId: string; workspaceId: string }, id: string, reason?: string) =>
  transition(db, ctx.workspaceId, id, "CANCELLED", reason ?? "MANUAL", ctx.userId);

/** سجل تنفيذ + مقاييس من صفوف المستلمين والأحداث (بلا بيانات شخصية). */
export async function getCampaignRunlog(db: Db, workspaceId: string, campaignId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== workspaceId) throw new NotFoundError("Campaign");
  const recipients = await (db as unknown as {
    campaignRecipient: { groupBy: (a: unknown) => Promise<Array<Record<string, unknown>>> };
  }).campaignRecipient.groupBy({ by: ["status"], where: { campaignId }, _count: { status: true } });
  const counts: Record<string, number> = {};
  for (const r of recipients) counts[String(r.status)] = Number((r as { _count?: { status?: number } })._count?.status ?? 0);
  const events = await (db as unknown as {
    campaignEvent: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
  }).campaignEvent.findMany({ where: { campaignId }, orderBy: { createdAt: "desc" }, take: 50 });
  return {
    status: campaign.status,
    recipients: {
      pending: counts.PENDING ?? 0,
      queued: counts.QUEUED ?? 0,
      sent: counts.SENT ?? 0,
      failed: counts.FAILED ?? 0,
      excluded: counts.EXCLUDED ?? 0,
      cancelled: counts.CANCELLED ?? 0,
    },
    events: events.map((e) => ({
      type: e.type,
      reason: e.reason,
      count: e.count,
      createdAt: e.createdAt,
    })),
  };
}

export type { CampaignCreateInput };
