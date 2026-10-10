import type { Prisma } from "@prisma/client";
import type { Db } from "@/modules/customers/service";
import { AppError, NotFoundError } from "@/core/errors";
import {
  SEGMENT_VERSION,
  segmentDefinitionSchema,
  type SegmentDefinition,
  type SegmentCondition,
  type ExclusionReason,
} from "./segment-schemas";

/**
 * P9 — تقييم الشريحة: حتمي بالكامل من قاعدة البيانات وبضوابط مغلقة.
 * كل قراءة مقيّدة بـ workspaceId (العزل من الاستعلام نفسه لا من الواجهة)،
 * وبحد أقصى للمرشحين حتى لا تتحول المعاينة إلى مسح غير محدود.
 */

export const SEGMENT_MAX_CANDIDATES = 5000;

export interface EligibilityResult {
  candidates: Array<Record<string, unknown>>;
  eligible: Array<Record<string, unknown>>;
  excludedCount: number;
  byReason: Record<ExclusionReason, number>;
  byChannel: Record<string, number>;
  computedAt: string;
  truncated: boolean;
}

function daysBoundary(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 3600_000);
}

/** بناء شرط Customer حتمي من الشرط المغلق — لا يخرج عن القيم المسماة. */
function conditionToWhere(c: SegmentCondition, now: Date): Prisma.CustomerWhereInput {
  switch (c.field) {
    case "customer.tags": {
      const tags = Array.isArray(c.value) ? c.value : [c.value];
      return c.op === "EQ" ? { tags: { hasEvery: tags } } : { tags: { hasSome: tags } };
    }
    case "customer.status": {
      const statuses: string[] = Array.isArray(c.value) ? [...c.value] : [c.value];
      return c.op === "EQ" ? { status: statuses[0] as never } : { status: { in: statuses as never } };
    }
    case "customer.adSource":
      return c.op === "EQ" ? { adSource: c.value as string } : { adSource: { in: c.value as string[] } };
    case "customer.marketingConsent":
      return { marketingConsent: c.value as never };
    case "customer.language":
      return c.op === "EQ" ? { language: c.value as string } : { language: { in: c.value as string[] } };
    case "customer.lastContact": {
      if (c.op === "WITHIN_DAYS") return { lastContactAt: { gte: daysBoundary(c.days, now) } };
      return { OR: [{ lastContactAt: { lt: daysBoundary(c.days, now) } }, { lastContactAt: null }] };
    }
    case "orders.hasAny":
      return c.value ? { orders: { some: {} } } : { orders: { none: {} } };
    case "orders.status": {
      const statuses = (Array.isArray(c.value) ? c.value : [c.value]) as string[];
      return { orders: { some: { status: { in: statuses as never } } } };
    }
    case "conversation.lastCustomerMessage": {
      if (c.op === "WITHIN_DAYS") {
        return { conversations: { some: { deletedAt: null, lastCustomerMessageAt: { gte: daysBoundary(c.days, now) } } } };
      }
      return {
        OR: [
          { conversations: { none: { deletedAt: null, lastCustomerMessageAt: { gte: daysBoundary(c.days, now) } } } },
          { conversations: { none: { deletedAt: null } } },
        ],
      };
    }
    case "conversation.noReply":
      // مقارنة أعمدة (آخر رسالة موظف بعد آخر رسالة عميل) غير مدعومة في
      // Prisma where — تُطبق حتميًا بعد الجلب (post-filter bounded).
      return {};
    default:
      throw new AppError("شرط شريحة غير مدعوم", 422, "INVALID_SEGMENT");
  }
}

function conditionsToWhere(definition: SegmentDefinition, now: Date): Prisma.CustomerWhereInput {
  const parts = definition.conditions.map((c) => conditionToWhere(c, now));
  return definition.match === "ALL" ? { AND: parts } : { OR: parts };
}

/**
 * تقييم الشريحة داخل مساحة العمل: مرشحون حسب التعريف ثم استبعادات السياسة
 * لكل عميل (القائمة السوداء، الموافقة، توفر قناة اتصال). لا يُكتب شيء.
 */
export async function evaluateSegment(
  db: Db,
  input: {
    workspaceId: string;
    definition: unknown;
    channelType?: string | null;
    channelId?: string | null;
    now?: Date;
  }
): Promise<EligibilityResult> {
  const parsed = segmentDefinitionSchema.safeParse(input.definition);
  if (!parsed.success) {
    throw new AppError("تعريف شريحة غير صالح", 422, "INVALID_SEGMENT");
  }
  const definition = parsed.data;
  const now = input.now ?? new Date();

  const candidates = (await db.customer.findMany({
    where: { workspaceId: input.workspaceId, ...conditionsToWhere(definition, now) },
    orderBy: { createdAt: "asc" },
    take: SEGMENT_MAX_CANDIDATES + 1,
  })) as unknown as Array<Record<string, unknown>>;

  // شرط "لم يردوا" (noReply) — تعريف موثق: لديه محادثة نشطة (غير محذوفة)
  // آخر رسالة فيها من الموظف/الذكاء (lastAgentMessageAt) بعد آخر رسالة
  // عميل (أو بلا رسائل عميل أصلًا). مقارنة أعمدة → فلترة حتمية بعد الجلب.
  const noReplyConds = definition.conditions.filter((c) => c.field === "conversation.noReply");
  if (noReplyConds.length) {
    const ids0 = candidates.map((c) => String(c.id));
    const convs = ids0.length
      ? await db.conversation.findMany({
          where: { workspaceId: input.workspaceId, customerId: { in: ids0 }, deletedAt: null },
          select: { customerId: true, lastAgentMessageAt: true, lastCustomerMessageAt: true },
        })
      : [];
    const noReplySet = new Set<string>();
    for (const cv of convs) {
      const agent = cv.lastAgentMessageAt ? new Date(cv.lastAgentMessageAt).getTime() : NaN;
      const cust = cv.lastCustomerMessageAt ? new Date(cv.lastCustomerMessageAt).getTime() : NaN;
      const noReply = Number.isFinite(agent) && (!Number.isFinite(cust) || agent > cust);
      if (noReply) noReplySet.add(cv.customerId);
    }
    const wantNoReply = noReplyConds.some((c) => c.op === "EQ" && c.value === true);
    const filtered = candidates.filter((c) => (wantNoReply ? noReplySet.has(String(c.id)) : !noReplySet.has(String(c.id))));
    candidates.length = 0;
    candidates.push(...filtered);
  }

  const truncated = candidates.length > SEGMENT_MAX_CANDIDATES;
  if (truncated) candidates.length = SEGMENT_MAX_CANDIDATES;

  // هويات القنوات لكل عميل (توفر قناة اتصال على نوع قناة الحملة).
  const ids = candidates.map((c) => String(c.id));
  const identities = ids.length
    ? await db.channelIdentity.findMany({
        where: {
          workspaceId: input.workspaceId,
          customerId: { in: ids },
          ...(input.channelType ? { channelType: input.channelType as never } : {}),
        },
        select: { customerId: true, channelType: true },
      })
    : [];
  const contactByCustomer = new Map<string, Set<string>>();
  for (const i of identities) {
    const set = contactByCustomer.get(i.customerId) ?? new Set<string>();
    set.add(i.channelType);
    contactByCustomer.set(i.customerId, set);
  }

  const byReason = {} as Record<ExclusionReason, number>;
  const byChannel: Record<string, number> = {};
  const eligible: Array<Record<string, unknown>> = [];
  let excludedCount = 0;

  for (const c of candidates) {
    let reason: ExclusionReason | null = null;
    if (c.isBlacklisted === true) reason = "BLACKLISTED";
    else if (c.marketingOptOutAt || c.marketingConsent === "OPTED_OUT") reason = "OPTED_OUT";
    else if (c.marketingConsent !== "OPTED_IN") reason = "NO_CONSENT";
    else if (input.channelType && !(contactByCustomer.get(String(c.id)) ?? new Set()).has(input.channelType)) {
      reason = "NO_CHANNEL_CONTACT";
    }
    if (reason) {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      excludedCount += 1;
      continue;
    }
    eligible.push(c);
    if (input.channelType) {
      byChannel[input.channelType] = (byChannel[input.channelType] ?? 0) + 1;
    } else {
      for (const ch of contactByCustomer.get(String(c.id)) ?? []) {
        byChannel[ch] = (byChannel[ch] ?? 0) + 1;
      }
    }
  }

  return {
    candidates,
    eligible,
    excludedCount,
    byReason,
    byChannel,
    computedAt: now.toISOString(),
    truncated,
  };
}

/** معاينة الشريحة المحفوظة (أرقام من DB — بلا بيانات شخصية في النتيجة). */
export async function previewSegmentById(
  db: Db,
  workspaceId: string,
  segmentId: string,
  channelType?: string | null
) {
  const segment = await db.audienceSegment.findUnique({ where: { id: segmentId } });
  if (!segment || segment.workspaceId !== workspaceId) throw new NotFoundError("Segment");
  const result = await evaluateSegment(db, {
    workspaceId,
    definition: segment.definition,
    channelType,
  });
  return {
    segment: {
      id: segment.id,
      name: segment.name,
      definition: segment.definition,
      version: SEGMENT_VERSION,
      isActive: segment.isActive,
      updatedAt: segment.updatedAt,
    },
    eligibleCount: result.eligible.length,
    excludedCount: result.excludedCount,
    byReason: result.byReason,
    byChannel: result.byChannel,
    truncated: result.truncated,
    computedAt: result.computedAt,
  };
}
