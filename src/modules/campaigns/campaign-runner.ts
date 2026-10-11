import type { Db } from "@/modules/customers/service";
import { AppError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { enqueueJob } from "@/modules/jobs/service";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { evaluateSegment, frequencyCapDays } from "./segment-service";
import { segmentDefinitionSchema } from "./segment-schemas";
import { campaignRequiresTemplate, checkRecipientEligibility } from "./eligibility";
import { CAMPAIGN_BATCH_MAX, CAMPAIGN_MAX_ATTEMPTS } from "./campaign-schemas";

/**
 * P9 — مشغّل الحملة: جدولة durable عبر BackgroundJob (بلا ذاكرة Node):
 * run_campaign → لقطة مستلمين → tick متسلسل (enqueue التالي قبل المعالجة
 * حتى لا يعلق عند crash) بحد دفعات صريح وحد معدل دقيق عبر نافذة دقيقة
 * محفوظة على صف الحملة نفسها. كل إرسال يمر عبر dispatchOutbound القائم
 * (idempotency + سياسات + تصنيف عابر/دائم) مع إعادة تحقق أهلية المستلم.
 */

/** P12 — نتيجة مؤقتة لحملة نظام خارجي (الكليبر) عند الانتهاء/الإلغاء/الفشل. */
async function notifyExternalOutcome(db: Db, campaignId: string) {
  try {
    const { emitRetargetResult } = await import("@/modules/integrations/clipper");
    await emitRetargetResult(db, campaignId, false);
  } catch {
    /* best-effort — لا يوقف دورة الحملة */
  }
}

async function addEvent(
  db: Db,
  workspaceId: string,
  campaignId: string,
  type: string,
  opts: { reason?: string | null; count?: number } = {}
) {
  await (db as unknown as {
    campaignEvent: { create: (a: unknown) => Promise<unknown> };
  }).campaignEvent.create({
    data: { workspaceId, campaignId, type: type as never, reason: opts.reason ?? null, count: opts.count ?? 0, payload: {} },
  } as never).catch(() => {});
}

/** بوابة البدء (قسم 8) — كل فشل مسجل بحدث POLICY_BLOCKED وسبب مغلق. */
export async function startCampaignRun(db: Db, campaignId: string): Promise<{ started: boolean; reason?: string }> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new NotFoundError("Campaign");
  const ws = campaign.workspaceId;

  const fail = async (reason: string) => {
    await db.campaign.update({ where: { id: campaignId }, data: { status: "FAILED", failReason: reason } as never });
    await addEvent(db, ws, campaignId, "POLICY_BLOCKED", { reason });
    await recordAudit(db, { workspaceId: ws, action: "campaign.start_blocked", entityType: "Campaign", entityId: campaignId, metadata: { reason } });
    await notifyExternalOutcome(db, campaignId);
    return { started: false, reason };
  };

  // الحالة: SCHEDULED فقط (إعادة تسليم المهمة بعد CANCELLED/FAILED لا تُشغّل).
  if (campaign.status !== "SCHEDULED") return { started: false, reason: `STATUS_${campaign.status}` };
  // الموافقة: نسخة محتوى معتمدة مثبتة.
  if (!campaign.contentVersionId || !campaign.approvedAt) return fail("NOT_APPROVED");
  const version = await (db as unknown as {
    campaignContentVersion: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> };
  }).campaignContentVersion.findUnique({ where: { id: String(campaign.contentVersionId) } });
  if (!version || version.status !== "APPROVED") return fail("NOT_APPROVED");
  if (campaignRequiresTemplate(campaign.channelType) && !version.templateName) return fail("TEMPLATE_REQUIRED");
  // القناة: متصلة + مملوكة.
  const channelId = campaign.channelId;
  if (channelId) {
    const channel = await db.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.workspaceId !== ws || channel.type !== campaign.channelType) return fail("CHANNEL_INVALID");
    if (channel.status !== "CONNECTED") return fail("CHANNEL_NOT_CONNECTED");
    const account = await db.channelAccount.findFirst({ where: { channelId }, select: { id: true } });
    if (!account) return fail("CHANNEL_NOT_CONNECTED");
  }
  // الشريحة مملوكة ونشطة.
  const segment = await db.audienceSegment.findUnique({ where: { id: campaign.segmentId } });
  if (!segment || segment.workspaceId !== ws || !segment.isActive) return fail("SEGMENT_INVALID");

  // لقطة المستلمين من تقييم جديد (الأهلية تُعاد لكل مستلم لحظة الإرسال أيضًا).
  const result = await evaluateSegment(db, {
    workspaceId: ws,
    definition: segment.definition,
    channelType: campaign.channelType,
    channelId: null,
  });
  if (!result.eligible.length) return fail("EMPTY_AUDIENCE");

  await (db as unknown as {
    campaignRecipient: { createMany: (a: unknown) => Promise<unknown> };
  }).campaignRecipient.createMany({
    data: result.eligible.map((c) => ({
      workspaceId: ws,
      campaignId,
      customerId: String(c.id),
      status: "PENDING",
    })),
    skipDuplicates: true, // idempotency: إعادة تسليم المهمة لا تضاعف اللقطة
  } as never);

  await db.campaign.update({
    where: { id: campaignId },
    data: { status: "RUNNING", startedAt: new Date(), lastTickSeq: 0, sentInWindow: 0, windowStartAt: null } as never,
  });
  await addEvent(db, ws, campaignId, "STARTED", { count: result.eligible.length });
  await recordAudit(db, {
    workspaceId: ws,
    action: "campaign.started",
    entityType: "Campaign",
    entityId: campaignId,
    metadata: { recipients: result.eligible.length },
  });
  // enqueue أول tick (بعد المعالجة هنا — المفتاح فريد لكل تسلسل).
  await enqueueJob(db, {
    workspaceId: ws,
    type: "campaign_tick",
    payload: { campaignId, seq: 1 },
    runAfter: new Date(),
    idempotencyKey: `campaign:${campaignId}:tick:1`,
  });
  return { started: true };
}

/**
 * tick واحد: يقرأ الحالة من DB (إيقاف/إلغاء فوري)، يطبق نافذة الدقيقة،
 * يعالج دفعة bounded، وينشئ tick التالي إن بقي عمل والحالة RUNNING.
 */
export async function campaignTick(db: Db, campaignId: string, seq: number): Promise<{ done: boolean; sent: number }> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new NotFoundError("Campaign");
  const ws = campaign.workspaceId;

  if (campaign.status !== "RUNNING") {
    // إيقاف/إلغاء/إكمال — لا إرسال بعد ذلك أبدًا. تنظيف PENDING حسب الحالة.
    if (campaign.status === "CANCELLED") {
      await (db as unknown as {
        campaignRecipient: { updateMany: (a: unknown) => Promise<unknown> };
      }).campaignRecipient.updateMany({
        where: { campaignId, status: "PENDING" },
        data: { status: "CANCELLED" } as never,
      });
      await addEvent(db, ws, campaignId, "CANCELLED", { reason: campaign.cancelReason ?? null });
      await notifyExternalOutcome(db, campaignId);
    }
    await finalizeIfDone(db, campaignId);
    return { done: true, sent: 0 };
  }

  // نافذة الدقيقة المحفوظة على صف الحملة (durable عبر إعادة التشغيل).
  const now = Date.now();
  const windowStart = campaign.windowStartAt ? new Date(campaign.windowStartAt as unknown as string).getTime() : 0;
  let allowance = campaign.ratePerMinute;
  if (windowStart && now - windowStart < 60_000) {
    allowance = Math.max(0, campaign.ratePerMinute - Number(campaign.sentInWindow ?? 0));
  }
  const batch = Math.min(CAMPAIGN_BATCH_MAX, allowance);
  if (batch <= 0) {
    // النافذة ممتلئة — tick لاحق بعد بقية الدقيقة.
    const waitMs = Math.max(2000, 60_000 - (now - (windowStart || now)));
    await enqueueJob(db, {
      workspaceId: ws,
      type: "campaign_tick",
      payload: { campaignId, seq },
      runAfter: new Date(now + waitMs),
      idempotencyKey: `campaign:${campaignId}:tick:${seq}`,
    });
    return { done: false, sent: 0 };
  }

  const pending = (await (db as unknown as {
    campaignRecipient: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> };
  }).campaignRecipient.findMany({
    where: { campaignId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: batch,
  })) as unknown as Array<{ id: string; customerId: string; attempts: number }>;

  // القناة مرة واحدة لكل دفعة (تتحقق حيًا — الإيقاف الفوري عند انقطاعها).
  const requireTemplate = campaignRequiresTemplate(campaign.channelType);
  let sentCount = 0;
  // P12 — سقف التكرار من تعريف الشريحة (يُعاد فحصه لكل مستلم لحظة الإرسال).
  const segmentRow = await db.audienceSegment.findUnique({ where: { id: campaign.segmentId } });
  const parsedDef = segmentDefinitionSchema.safeParse(segmentRow?.definition);
  const capDays = parsedDef.success ? frequencyCapDays(parsedDef.data) : null;

  for (const r of pending) {
    // إعادة قراءة الحالة قبل كل إرسال (إيقاف فوري بين مستلم وآخر).
    const fresh = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!fresh || fresh.status !== "RUNNING") break;

    const check = await checkRecipientEligibility(db, {
      workspaceId: ws,
      customerId: r.customerId,
      channelType: campaign.channelType,
      channelId: campaign.channelId,
      requireTemplate,
      frequencyCapDays: capDays,
      recipientId: r.id,
    });
    if (!check.ok) {
      await (db as unknown as {
        campaignRecipient: { update: (a: unknown) => Promise<unknown> };
      }).campaignRecipient.update({
        where: { id: r.id },
        data: { status: "EXCLUDED", excludeReason: check.reason } as never,
      });
      await addEvent(db, ws, campaignId, "RECIPIENT_EXCLUDED", { reason: check.reason, count: 1 });
      continue;
    }

    // محادثة: قائمة قيد الاستخدام أو سلسلة حملة جديدة مميزة.
    let conversationId = check.conversationId ?? null;
    if (!conversationId) {
      const ch = campaign.channelId
        ? await db.channel.findUnique({ where: { id: campaign.channelId }, select: { id: true } })
        : await db.channel.findFirst({ where: { workspaceId: ws, type: campaign.channelType as never, status: "CONNECTED" }, select: { id: true } });
      if (!ch) {
        await (db as unknown as {
          campaignRecipient: { update: (a: unknown) => Promise<unknown> };
        }).campaignRecipient.update({
          where: { id: r.id },
          data: { status: "FAILED", lastError: "CHANNEL_NOT_CONNECTED", errorCategory: "PERMANENT" } as never,
        });
        continue;
      }
      const created = await (db as unknown as {
        conversation: { create: (a: unknown) => Promise<{ id: string }> };
      }).conversation.create({
        data: {
          workspaceId: ws,
          customerId: r.customerId,
          channelId: ch.id,
          channelConversationId: `camp-${campaignId}-${r.customerId}`,
          status: "OPEN",
          aiState: "HUMAN_ACTIVE", // حملة تسويقية = موظف/نظام، بلا AI تلقائي
          aiEnabled: false,
        },
      } as never);
      conversationId = created.id;
    }
    await (db as unknown as {
      campaignRecipient: { update: (a: unknown) => Promise<unknown> };
    }).campaignRecipient.update({
      where: { id: r.id },
      data: { conversationId, attempts: { increment: 1 } } as never,
    });

    const version = campaign.contentVersionId
      ? await (db as unknown as {
          campaignContentVersion: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> };
        }).campaignContentVersion.findUnique({ where: { id: String(campaign.contentVersionId) } })
      : null;
    if (!version) {
      await (db as unknown as {
        campaignRecipient: { update: (a: unknown) => Promise<unknown> };
      }).campaignRecipient.update({
        where: { id: r.id },
        data: { status: "FAILED", lastError: "CONTENT_VERSION_MISSING", errorCategory: "PERMANENT" } as never,
      });
      continue;
    }

    // الإرسال عبر المسار القائم الوحيد (idempotency + سياسة + تصنيف أخطاء).
    const res = await dispatchOutbound(db, {
      workspaceId: ws,
      conversationId,
      sourceMessageId: `campaign:${campaignId}:${r.id}`,
      text: String(version.text ?? ""),
      senderType: "HUMAN",
      senderId: "campaign-system",
      ...(requireTemplate
        ? {
            template: {
              name: String(version.templateName ?? ""),
              language: String(version.templateLanguage ?? "ar"),
              variables: (version.templateVariables ?? {}) as Record<string, string>,
            },
          }
        : {}),
    } as never);

    if (res.deliveryStatus === "SENT") {
      await (db as unknown as {
        campaignRecipient: { update: (a: unknown) => Promise<unknown> };
      }).campaignRecipient.update({
        where: { id: r.id },
        data: { status: "SENT", messageId: res.messageId, sentAt: new Date(), lastError: null } as never,
      });
      await addEvent(db, ws, campaignId, "RECIPIENT_SENT", { count: 1 });
      sentCount += 1;
    } else if (res.deliveryStatus === "SKIPPED_DUPLICATE") {
      // قبول مسبق (SENT) — احتساب بدون إرسال مزدوج.
      await (db as unknown as {
        campaignRecipient: { update: (a: unknown) => Promise<unknown> };
      }).campaignRecipient.update({
        where: { id: r.id },
        data: { status: "SENT", messageId: res.messageId, sentAt: new Date() } as never,
      });
      sentCount += 1;
    } else if (res.deliveryStatus === "QUEUED") {
      // عابر: يبقى PENDING لإعادة المحاولة بحد أقصى.
      const attempts = Number(r.attempts ?? 0) + 1;
      if (attempts >= CAMPAIGN_MAX_ATTEMPTS) {
        await (db as unknown as {
          campaignRecipient: { update: (a: unknown) => Promise<unknown> };
        }).campaignRecipient.update({
          where: { id: r.id },
          data: { status: "FAILED", lastError: res.error ?? "TRANSIENT_EXHAUSTED", errorCategory: "TRANSIENT" } as never,
        });
        await addEvent(db, ws, campaignId, "RECIPIENT_FAILED", { reason: "TRANSIENT_EXHAUSTED", count: 1 });
      } else {
        await (db as unknown as {
          campaignRecipient: { update: (a: unknown) => Promise<unknown> };
        }).campaignRecipient.update({
          where: { id: r.id },
          data: { status: "PENDING", lastError: res.error ?? "QUEUED" } as never,
        });
      }
    } else {
      // FAILED نهائي (يشمل POLICY_*).
      await (db as unknown as {
        campaignRecipient: { update: (a: unknown) => Promise<unknown> };
      }).campaignRecipient.update({
        where: { id: r.id },
        data: { status: "FAILED", lastError: res.error ?? "SEND_FAILED", errorCategory: "PERMANENT" } as never,
      });
      await addEvent(db, ws, campaignId, "RECIPIENT_FAILED", { reason: res.error ?? "SEND_FAILED", count: 1 });
    }
  }

  // تحديث نافذة المعدل على صف الحملة (durable).
  if (sentCount > 0) {
    const inWindow = windowStart && now - windowStart < 60_000;
    await db.campaign.update({
      where: { id: campaignId },
      data: {
        windowStartAt: inWindow ? (campaign.windowStartAt as Date) : new Date(now),
        sentInWindow: inWindow ? Number(campaign.sentInWindow ?? 0) + sentCount : sentCount,
      } as never,
    });
  }

  await finalizeIfDone(db, campaignId);

  // tick التالي — enqueue قبل الخروج (نمط استمرارية بعد crash).
  const freshCampaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  const remaining = await (db as unknown as {
    campaignRecipient: { count: (a: unknown) => Promise<number> };
  }).campaignRecipient.count({ where: { campaignId, status: "PENDING" } });
  if (freshCampaign?.status === "RUNNING" && remaining > 0) {
    await enqueueJob(db, {
      workspaceId: ws,
      type: "campaign_tick",
      payload: { campaignId, seq: seq + 1 },
      runAfter: new Date(Date.now() + 2000),
      idempotencyKey: `campaign:${campaignId}:tick:${seq + 1}`,
    });
  }
  return { done: remaining === 0, sent: sentCount };
}

/** إنجاز الحملة: لا PENDING/QUEUED متبقٍ → COMPLETED. */
async function finalizeIfDone(db: Db, campaignId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, workspaceId: true } });
  if (!campaign || campaign.status !== "RUNNING") return;
  const remaining = await (db as unknown as {
    campaignRecipient: { count: (a: unknown) => Promise<number> };
  }).campaignRecipient.count({ where: { campaignId, status: { in: ["PENDING", "QUEUED"] } as never } });
  if (remaining === 0) {
    await db.campaign.update({
      where: { id: campaignId },
      data: { status: "COMPLETED", completedAt: new Date() } as never,
    });
    await addEvent(db, campaign.workspaceId, campaignId, "COMPLETED");
    await recordAudit(db, {
      workspaceId: campaign.workspaceId,
      action: "campaign.completed",
      entityType: "Campaign",
      entityId: campaignId,
      metadata: {},
    });
    await notifyExternalOutcome(db, campaignId);
  }
}

/** Dry-run: كل ما يعيده startCampaignRun قبل أي كتابة مستلمين — يُستدعى في مسار معاينة منفصل بلا enqueue. */
export async function dryRunCampaign(db: Db, workspaceId: string, campaignId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.workspaceId !== workspaceId) throw new NotFoundError("Campaign");
  const segment = await db.audienceSegment.findUnique({ where: { id: campaign.segmentId } });
  if (!segment || segment.workspaceId !== workspaceId) throw new AppError("الشريحة غير موجودة", 422, "SEGMENT_INVALID");

  const result = await evaluateSegment(db, {
    workspaceId,
    definition: segment.definition,
    channelType: campaign.channelType,
  });
  const version = campaign.contentVersionId
    ? await (db as unknown as {
        campaignContentVersion: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> };
      }).campaignContentVersion.findUnique({ where: { id: String(campaign.contentVersionId) } })
    : null;
  // فحوصات البوابة (قراءة فقط) — أسباب مغلقة.
  const issues: string[] = [];
  if (!campaign.contentVersionId || !campaign.approvedAt) issues.push("NOT_APPROVED");
  if (campaignRequiresTemplate(campaign.channelType) && !version?.templateName) issues.push("TEMPLATE_REQUIRED");
  if (campaign.channelId) {
    const channel = await db.channel.findUnique({ where: { id: campaign.channelId }, select: { status: true, workspaceId: true, type: true } });
    if (!channel || channel.workspaceId !== workspaceId || channel.type !== campaign.channelType) issues.push("CHANNEL_INVALID");
    else if (channel.status !== "CONNECTED") issues.push("CHANNEL_NOT_CONNECTED");
  }
  if (!result.eligible.length) issues.push("EMPTY_AUDIENCE");
  return {
    dryRun: true,
    eligibleCount: result.eligible.length,
    excludedCount: result.excludedCount,
    byReason: result.byReason,
    byChannel: result.byChannel,
    channelType: campaign.channelType,
    ratePerMinute: campaign.ratePerMinute,
    template: version?.templateName ? { name: version.templateName, language: version.templateLanguage } : null,
    scheduledAt: campaign.scheduledAt,
    timezone: campaign.timezone,
    issues,
    computedAt: result.computedAt,
  };
}
