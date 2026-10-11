import { AppError, AuthorizationError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { Db } from "@/modules/customers/service";
import type { Permission } from "@/modules/rbac/permissions";
import { buildRetargetCampaign, type RetargetSpec } from "@/modules/integrations/clipper";
import { findBannedClaims, getProductCompliance } from "@/modules/integrations/compliance";
import { findPii } from "@/modules/integrations/pii-guard";

/**
 * P12 — مسودات الوكلاء (Hermes): «المسودة مسودة» — بطابور المراجعة بعلامة
 * «مصدرها Hermes»، ولا أثر برّا قبل الاعتماد. الاعتماد يحوّلها لكيان حقيقي
 * بالمسار القائم نفسه:
 * - reply_template ← سؤال شائع (FAQ) فعّال يستخدمه الذكاء والفريق.
 * - retarget_campaign ← حملة READY بانتظار اعتماد الحملات العادي (campaigns.approve)
 *   — اعتماد المسودة لا يرسل أي رسالة.
 */

export const DRAFT_KINDS = ["reply_template", "retarget_campaign"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const DRAFT_TTL_DAYS = 7;

export interface ReplyTemplatePayload {
  topic: string;
  question: string;
  answer: string;
  dialect: string | null;
  productId: string | null;
  productCode: string | null;
}

export interface RetargetDraftPayload {
  spec: RetargetSpec;
  productCode: string | null;
  offerNote: string | null;
  /** عدد المؤهلين وقت المسودة (للعرض فقط — العدد الفعلي بينحسب عند الاعتماد والإرسال). */
  eligibleCount?: number | null;
}

type DraftRow = {
  id: string;
  workspaceId: string;
  tokenId: string | null;
  source: string;
  kind: string;
  title: string;
  payload: unknown;
  status: string;
  idempotencyKey: string | null;
  resultRef: string | null;
  decidedBy: string | null;
  decidedAt: Date | string | null;
  decisionNote: string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
};

function model(db: Db) {
  const m = (db as unknown as {
    agentDraft?: {
      create: (a: unknown) => Promise<unknown>;
      findUnique: (a: unknown) => Promise<unknown>;
      findFirst: (a: unknown) => Promise<unknown>;
      findMany: (a: unknown) => Promise<unknown>;
      update: (a: unknown) => Promise<unknown>;
      updateMany: (a: unknown) => Promise<{ count: number }>;
      count: (a: unknown) => Promise<number>;
    };
  }).agentDraft;
  if (!m) throw new AppError("Agent drafts unavailable", 500, "INTERNAL");
  return m;
}

export interface DraftView {
  id: string;
  source: string;
  kind: string;
  title: string;
  status: string;
  payload: unknown;
  resultRef: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
  createdAt: string;
  ageHours: number;
}

const iso = (v: Date | string | null): string | null => (v ? new Date(v).toISOString() : null);

export function toDraftView(row: DraftRow, now = new Date()): DraftView {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    title: row.title,
    status: row.status,
    payload: row.payload,
    resultRef: row.resultRef,
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt)!,
    ageHours: Math.max(0, Math.round((now.getTime() - new Date(row.createdAt).getTime()) / 3600_000)),
  };
}

/** مسودات انتهت مهلتها بلا قرار → EXPIRED (عند كل قراءة — لا مؤقت مخفي). */
export async function expireStaleDrafts(db: Db, workspaceId: string, now = new Date()): Promise<void> {
  // قرار انقطع بالنص (العملية وقفت بعد الحجز) ← يرجع «بانتظار» بعد 10 دقايق.
  await model(db).updateMany({
    where: { workspaceId, status: "DECIDING", updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
    data: { status: "PENDING", decidedBy: null },
  });
  await model(db).updateMany({
    where: { workspaceId, status: "PENDING", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  });
}

export async function createAgentDraft(
  db: Db,
  input: {
    workspaceId: string;
    tokenId: string | null;
    source: string;
    kind: DraftKind;
    title: string;
    payload: ReplyTemplatePayload | RetargetDraftPayload;
    idempotencyKey: string;
  }
): Promise<{ row: DraftRow; created: boolean }> {
  const existing = (await model(db).findFirst({
    where: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
  })) as DraftRow | null;
  if (existing) return { row: existing, created: false };
  try {
    const row = (await model(db).create({
      data: {
        workspaceId: input.workspaceId,
        tokenId: input.tokenId,
        source: input.source,
        kind: input.kind,
        title: input.title.slice(0, 200),
        payload: input.payload as never,
        status: "PENDING",
        idempotencyKey: input.idempotencyKey,
        expiresAt: new Date(Date.now() + DRAFT_TTL_DAYS * 24 * 3600_000),
      },
    })) as DraftRow;
    await recordAudit(db, {
      workspaceId: input.workspaceId,
      action: "agent.draft_created",
      entityType: "AgentDraft",
      entityId: row.id,
      metadata: { source: input.source, kind: input.kind },
    });
    return { row, created: true };
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const again = (await model(db).findFirst({
        where: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
      })) as DraftRow | null;
      if (again) return { row: again, created: false };
    }
    throw err;
  }
}

export async function listAgentDrafts(
  db: Db,
  workspaceId: string,
  filter: { status?: string; tokenId?: string; limit?: number } = {}
): Promise<DraftView[]> {
  await expireStaleDrafts(db, workspaceId);
  const rows = (await model(db).findMany({
    where: {
      workspaceId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.tokenId ? { tokenId: filter.tokenId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
  })) as DraftRow[];
  return rows.map((r) => toDraftView(r));
}

/** تحقق نص قالب رد: لا بيانات شخصية · لا ادعاء ممنوع من سيستم 1 · أطوال معقولة. */
export async function assertReplyTemplateSafe(db: Db, p: ReplyTemplatePayload): Promise<void> {
  if (!p.question.trim() || !p.answer.trim()) throw new AppError("السؤال والجواب مطلوبين", 422, "VALIDATION_FAILED");
  if (findPii({ question: p.question, answer: p.answer }).length > 0) {
    throw new AppError("القالب فيه رقم هاتف أو إيميل — مرفوض", 422, "PII_BLOCKED");
  }
  if (p.productId) {
    const c = await getProductCompliance(db, p.productId);
    const hits = c ? findBannedClaims(`${p.question} ${p.answer}`, c.bannedClaims) : [];
    if (hits.length > 0) throw new AppError(`القالب فيه ادعاء ممنوع من الامتثال: ${hits.join("، ")}`, 422, "BANNED_CLAIM");
  }
}

export interface DecideInput {
  decision: "approve" | "reject";
  note?: string | null;
  /** تعديل قالب الرد قبل الاعتماد (= EDITED). */
  edits?: { question?: string; answer?: string; topic?: string } | null;
}

export async function decideAgentDraft(
  db: Db,
  ctx: { userId: string; workspaceId: string; can: (p: Permission) => boolean },
  draftId: string,
  input: DecideInput
): Promise<DraftView> {
  await expireStaleDrafts(db, ctx.workspaceId);
  const row = (await model(db).findUnique({ where: { id: draftId } })) as DraftRow | null;
  if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError("Draft");
  if (row.status !== "PENDING") throw new AppError(`المسودة ${row.status} — ما بتنقرر مرة تانية`, 409, "DRAFT_ALREADY_DECIDED");

  const needed: Permission = row.kind === "retarget_campaign" ? "campaigns.write" : "knowledge.write";
  if (!ctx.can(needed)) throw new AuthorizationError(`صلاحية ${needed} مطلوبة`);

  // حجز ذري (PENDING ← DECIDING): موافقين اتنين بنفس اللحظة = واحد بس بيكمّل —
  // التاني بياخد 409 بدل ما يعمل FAQ أو حملة تانية.
  const claimed = await model(db).updateMany({
    where: { id: draftId, workspaceId: ctx.workspaceId, status: "PENDING" },
    data: { status: "DECIDING", decidedBy: ctx.userId },
  });
  if (claimed.count !== 1) throw new AppError("المسودة عم تنقرر أو انقررت — حدّث الصفحة", 409, "DRAFT_ALREADY_DECIDED");

  if (input.decision === "reject") {
    const updated = (await model(db).update({
      where: { id: draftId },
      data: { status: "REJECTED", decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: input.note?.slice(0, 500) ?? null },
    })) as DraftRow;
    await recordAudit(db, { workspaceId: ctx.workspaceId, userId: ctx.userId, action: "agent.draft_rejected", entityType: "AgentDraft", entityId: draftId, metadata: { kind: row.kind } });
    return toDraftView(updated);
  }

  try {
    return await approveClaimedDraft(db, ctx, row, input);
  } catch (err) {
    // فشل التنفيذ (ادعاء ممنوع · قناة مفصولة …) = المسودة بترجع «بانتظار» للتعديل أو الرفض.
    await model(db)
      .updateMany({ where: { id: draftId, status: "DECIDING" }, data: { status: "PENDING", decidedBy: null } })
      .catch(() => undefined);
    throw err;
  }
}

async function approveClaimedDraft(
  db: Db,
  ctx: { userId: string; workspaceId: string },
  row: DraftRow,
  input: DecideInput
): Promise<DraftView> {
  const draftId = row.id;
  let resultRef: string;
  let status = "APPROVED";
  if (row.kind === "reply_template") {
    const p = { ...(row.payload as ReplyTemplatePayload) };
    if (input.edits) {
      if (input.edits.question) p.question = input.edits.question.slice(0, 500);
      if (input.edits.answer) p.answer = input.edits.answer.slice(0, 2000);
      if (input.edits.topic) p.topic = input.edits.topic.slice(0, 60);
      status = "EDITED";
    }
    await assertReplyTemplateSafe(db, p);
    const faq = (await db.faq.create({
      data: {
        workspaceId: ctx.workspaceId,
        productId: p.productId,
        question: p.question,
        answer: p.answer,
        category: p.topic,
        tags: ["hermes", ...(p.dialect ? [p.dialect] : [])],
        isActive: true,
      },
    })) as { id: string };
    resultRef = faq.id;
  } else if (row.kind === "retarget_campaign") {
    const p = row.payload as RetargetDraftPayload;
    const { campaignId } = await buildRetargetCampaign(db, {
      workspaceId: ctx.workspaceId,
      source: "hermes",
      actor: ctx.userId,
      spec: { ...p.spec, approvedBy: ctx.userId },
    });
    resultRef = campaignId;
  } else {
    throw new AppError("نوع مسودة غير معروف", 422, "UNKNOWN_DRAFT_KIND");
  }
  const updated = (await model(db).update({
    where: { id: draftId },
    data: { status, resultRef, decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: input.note?.slice(0, 500) ?? null },
  })) as DraftRow;
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "agent.draft_approved",
    entityType: "AgentDraft",
    entityId: draftId,
    metadata: { kind: row.kind, resultRef, edited: status === "EDITED" },
  });
  return toDraftView(updated);
}

/** مسودات التوكن منذ «since» (بداية اليوم بمنطقة مساحة العمل — نفس يوم الجسر). */
export async function countDraftsSince(db: Db, tokenId: string, since: Date): Promise<number> {
  return model(db).count({ where: { tokenId, createdAt: { gte: since } } });
}

/** مسودة موجودة بنفس مفتاح عدم التكرار (إعادة نداء = نفس المسودة بلا سقف). */
export async function findDraftByKey(db: Db, workspaceId: string, idempotencyKey: string): Promise<DraftRow | null> {
  return (await model(db).findFirst({ where: { workspaceId, idempotencyKey } })) as DraftRow | null;
}

export type { DraftRow };
