import type { Prisma, FeedbackKind } from "@prisma/client";
import { NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db, Paginated } from "@/modules/customers/service";

export interface FeedbackInput {
  kind?: FeedbackKind;
  productId?: string | null;
  customerId?: string | null;
  mediaId?: string | null;
  content?: string | null;
  customerSegment?: string | null;
  source?: string | null;
  rating?: number | null;
  sentiment?: string | null;
  tags?: string[];
}

/** Simple rule-based sentiment for the analyze_feedback job (no AI yet). */
const POSITIVE = ["ممتاز", "رائع", "شكرا", "شكرًا", "أحب", "جميل", "جيد", "excellent", "great", "love", "good", "أنصح"];
const NEGATIVE = ["سيء", "سيئ", "مكسور", "متأخر", "مشكلة", "شكوى", "bad", "broken", "late", "problem", "complaint", "لا أنصح"];

export function classifySentiment(text: string): "positive" | "negative" | "neutral" {
  const lower = text.toLowerCase();
  const pos = POSITIVE.some((w) => lower.includes(w.toLowerCase()));
  const neg = NEGATIVE.some((w) => lower.includes(w.toLowerCase()));
  if (pos && !neg) return "positive";
  if (neg && !pos) return "negative";
  return "neutral";
}

export async function createFeedback(db: Db, ctx: ActorContext, input: FeedbackInput) {
  for (const ref of ["productId", "customerId", "mediaId"] as const) {
    const id = input[ref];
    if (!id) continue;
    if (ref === "productId") {
      const row = await db.product.findUnique({ where: { id }, select: { workspaceId: true } });
      if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError(ref);
    } else if (ref === "customerId") {
      const row = await db.customer.findUnique({ where: { id }, select: { workspaceId: true } });
      if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError(ref);
    } else {
      const row = await db.mediaAsset.findUnique({ where: { id }, select: { workspaceId: true } });
      if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError(ref);
    }
  }

  const feedback = await db.feedback.create({
    data: {
      ...input,
      workspaceId: ctx.workspaceId,
      sentiment: input.sentiment ?? (input.content ? classifySentiment(input.content) : null),
      // Testimonial safety: content is stored verbatim as quoted source material.
    } as Prisma.FeedbackUncheckedCreateInput,
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "feedback.created",
    entityType: "Feedback",
    entityId: feedback.id,
  });
  await eventBus.publish(makeEvent("FeedbackCreated", ctx.workspaceId, { feedbackId: feedback.id }));
  return feedback;
}

export async function getOwnedFeedback(db: Db, workspaceId: string, feedbackId: string) {
  const feedback = await db.feedback.findUnique({ where: { id: feedbackId }, include: { media: true, product: { select: { id: true, name: true } } } });
  if (!feedback || feedback.workspaceId !== workspaceId) throw new NotFoundError("Feedback");
  return feedback;
}

export async function listFeedback(
  db: Db,
  params: {
    workspaceId: string;
    productId?: string;
    sentiment?: string;
    approved?: boolean;
    archived?: boolean;
    q?: string;
    cursor?: string;
    limit?: number;
  }
): Promise<Paginated<Prisma.FeedbackGetPayload<{ include: { media: true; product: { select: { id: true; name: true } } } }>>> {
  const limit = Math.min(params.limit ?? 25, 100);
  const where: Prisma.FeedbackWhereInput = { workspaceId: params.workspaceId };
  if (params.productId) where.productId = params.productId;
  if (params.sentiment) where.sentiment = params.sentiment;
  if (params.approved !== undefined) where.isApproved = params.approved;
  if (params.archived !== undefined) where.isArchived = params.archived;
  else where.isArchived = false;
  if (params.q) where.content = { contains: params.q, mode: "insensitive" };

  const feedbacks = await db.feedback.findMany({
    where,
    include: { media: true, product: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = feedbacks.length > limit;
  const items = hasMore ? feedbacks.slice(0, limit) : feedbacks;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function updateFeedback(
  db: Db,
  ctx: ActorContext,
  feedbackId: string,
  data: FeedbackInput & { isApproved?: boolean; isArchived?: boolean }
) {
  await getOwnedFeedback(db, ctx.workspaceId, feedbackId);
  const updated = await db.feedback.update({
    where: { id: feedbackId },
    data: data as Prisma.FeedbackUncheckedUpdateInput,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: data.isApproved !== undefined ? (data.isApproved ? "feedback.approved" : "feedback.unapproved") : "feedback.updated",
    entityType: "Feedback",
    entityId: feedbackId,
    metadata: { fields: Object.keys(data) },
  });
  await eventBus.publish(makeEvent("FeedbackUpdated", ctx.workspaceId, { feedbackId }));
  return updated;
}

/** Retrieval for AI/context: ONLY approved, non-archived feedback. */
export async function getApprovedFeedbackForProduct(
  db: Db,
  workspaceId: string,
  productId: string,
  limit = 3
) {
  return db.feedback.findMany({
    where: { workspaceId, productId, isApproved: true, isArchived: false },
    orderBy: [{ rating: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
}
