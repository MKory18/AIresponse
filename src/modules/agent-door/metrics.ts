import { median } from "@/core/analytics/time";
import type { Db } from "@/modules/customers/service";
import { getAgentAnalytics } from "@/modules/analytics/agents";
import { AppError } from "@/core/errors";
import { agentRef, channelKey, fullChannelCounts, isoInZone } from "@/modules/integrations/format";
import { redactContacts } from "@/modules/integrations/pii-guard";
import { capacityCore } from "@/modules/integrations/capacity";
import type { ResolvedPeriod } from "./period";

/**
 * P12 — أرقام أدوات باب الوكلاء: من نفس قاعدة البيانات ونفس تعريفات شاشات
 * التحليلات (P10) — لا حساب مكرر ولا تقدير. أي رقم بلا عيّنة = null لا صفر.
 */

const CONFIRMED = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED"];
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 21;
export const DEFAULT_SLA_MIN = 15;

export const INTENT_LABELS_AR: Record<string, string> = {
  GREETING: "تحية",
  PRODUCT_QUESTION: "أسئلة عن المنتج",
  PRICE_QUESTION: "السعر",
  AVAILABILITY: "التوفر",
  PRODUCT_COMPARISON: "مقارنة منتجات",
  HOW_TO_USE: "طريقة الاستخدام",
  BENEFITS: "الفوائد",
  FEEDBACK_REQUEST: "تجارب الزبائن",
  DELIVERY_QUESTION: "التوصيل",
  PAYMENT_QUESTION: "الدفع",
  RETURN_REQUEST: "الإرجاع",
  COMPLAINT: "شكوى",
  ORDER_CREATE: "طلب جديد",
  ORDER_UPDATE: "تعديل طلب",
  ORDER_CANCEL: "إلغاء طلب",
  TRACK_ORDER: "تتبع طلب",
  HUMAN_REQUEST: "طلب موظف",
  UNKNOWN: "غير مصنّف",
};

export function periodOut(p: ResolvedPeriod, tz: string) {
  return { from: isoInZone(p.start, tz), to: isoInZone(p.end, tz), label: p.label };
}

function localHour(d: Date, tz: string): number {
  return Number(isoInZone(d, tz).slice(11, 13));
}

/** أوقات الرد على دفعات الزبون خلال فترة (نفس تعريف قدرة الرد). */
async function burstResponses(db: Db, workspaceId: string, start: Date, end: Date, conversationIds?: string[]) {
  const msgs = (await db.message.findMany({
    where: {
      workspaceId,
      createdAt: { gte: start, lt: end },
      deletedAt: null,
      isNote: false,
      senderType: { in: ["CUSTOMER", "AI", "HUMAN"] },
      OR: [{ senderId: null }, { senderId: { not: "campaign-system" } }],
      ...(conversationIds ? { conversationId: { in: conversationIds } } : {}),
    } as never,
    select: { conversationId: true, direction: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 100_000,
  })) as Array<{ conversationId: string; direction: string; createdAt: Date | string }>;
  const waiting = new Map<string, number>();
  const minutes: number[] = [];
  const burstStarts: number[] = [];
  let inbound = 0;
  for (const m of msgs) {
    const t = new Date(m.createdAt).getTime();
    if (m.direction === "INBOUND") {
      inbound += 1;
      if (!waiting.has(m.conversationId)) {
        waiting.set(m.conversationId, t);
        burstStarts.push(t);
      }
    } else {
      const s = waiting.get(m.conversationId);
      if (s !== undefined) {
        minutes.push((t - s) / 60_000);
        waiting.delete(m.conversationId);
      }
    }
  }
  return { minutes, burstStarts, inbound, stillWaiting: [...waiting.values()] };
}

export const MARKETS = ["SY", "JO"] as const;
export type Market = (typeof MARKETS)[number];

/**
 * فلتر القنوات: page (معرّف الصفحة/الرقم أو اسمها) و/أو market (سوق القناة
 * المحدد بالإعدادات). سوق بلا ولا قناة = خطأ واضح، مش صفر مضلل.
 */
async function resolveChannelFilter(db: Db, workspaceId: string, page?: string | null, market?: string | null): Promise<string[] | undefined> {
  if (!page && !market) return undefined;
  const channels = (await db.channel.findMany({
    where: {
      workspaceId,
      ...(page ? { OR: [{ externalId: page }, { displayName: page }] } : {}),
      ...(market ? { market } : {}),
    } as never,
    select: { id: true },
  })) as Array<{ id: string }>;
  if (market && channels.length === 0) {
    throw new AppError(`ما في قناة محدد سوقها ${market} — حدّد سوق كل قناة من «الربط مع الأنظمة»`, 422, "VALIDATION_FAILED", [
      { path: "market", message: "no channel assigned to this market" },
    ]);
  }
  return channels.map((c) => c.id);
}

export async function inboxSummary(
  db: Db,
  workspaceId: string,
  p: ResolvedPeriod,
  tz: string,
  opts: { page?: string | null; market?: string | null; slaMin: number; now?: Date }
) {
  const channelIds = await resolveChannelFilter(db, workspaceId, opts.page, opts.market);
  const convWhere = {
    workspaceId,
    createdAt: { gte: p.start, lt: p.end },
    deletedAt: null,
    ...(channelIds ? { channelId: { in: channelIds } } : {}),
  };
  const conversations = await db.conversation.count({ where: convWhere as never });
  const scopedConvIds = channelIds
    ? ((await db.conversation.findMany({ where: { workspaceId, channelId: { in: channelIds } } as never, select: { id: true }, take: 20_000 })) as Array<{ id: string }>).map((c) => c.id)
    : undefined;
  const r = await burstResponses(db, workspaceId, p.start, p.end, scopedConvIds);
  const now = (opts.now ?? new Date()).getTime();
  const overSla =
    r.minutes.filter((m) => m > opts.slaMin).length + r.stillWaiting.filter((s) => (Math.min(now, p.end.getTime()) - s) / 60_000 > opts.slaMin).length;
  const afterHours = r.burstStarts.filter((t) => {
    const h = localHour(new Date(t), tz);
    return h < WORK_START_HOUR || h >= WORK_END_HOUR;
  }).length;
  // الرسائل المنتظرة الآن لكل قناة — نفس لب قدرة الرد حرفيًا (لا تعريف تاني).
  const core = await capacityCore(db, workspaceId, new Date(now), channelIds);
  const byChannel = core.byChannel;
  const unansweredNow = core.unanswered;
  const p50 = median(r.minutes);
  return {
    period: periodOut(p, tz),
    conversations,
    inbound_messages: r.inbound,
    first_response_p50_min: p50 === null ? null : Math.round(p50 * 10) / 10,
    responses_measured: r.minutes.length,
    over_sla: overSla,
    sla_minutes: opts.slaMin,
    unanswered_now: unansweredNow,
    after_hours_share: r.burstStarts.length ? Math.round((afterHours / r.burstStarts.length) * 1000) / 1000 : null,
    by_channel: fullChannelCounts(byChannel),
  };
}

async function productIdByCode(db: Db, workspaceId: string, code?: string | null): Promise<string | null | undefined> {
  if (!code) return undefined;
  const p = (await db.product.findFirst({ where: { workspaceId, sku: code }, select: { id: true } })) as { id: string } | null;
  return p?.id ?? null;
}

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

export async function salesFunnel(db: Db, workspaceId: string, p: ResolvedPeriod, tz: string, productCode?: string | null) {
  const range = { gte: p.start, lt: p.end };
  const productId = await productIdByCode(db, workspaceId, productCode);
  if (productId === null) {
    return {
      period: periodOut(p, tz),
      product_code: productCode ?? null,
      conversations: 0,
      drafts_started: 0,
      drafts_ready: 0,
      orders_confirmed: 0,
      orders_delivered: 0,
      rates: { draft_start: null, ready: null, confirm: null, delivery: null },
    };
  }
  const draftWhere = { workspaceId, createdAt: range, ...(productId ? { productId } : {}) };
  const [drafts, draftsReady] = await Promise.all([
    db.orderDraft.count({ where: { ...draftWhere, state: { not: "EMPTY" } } as never }),
    db.orderDraft.count({ where: { ...draftWhere, state: { in: ["READY", "CONFIRMING", "CONFIRMED", "CONVERTED"] } } as never }),
  ]);
  let conversations: number;
  let confirmed: number;
  let delivered: number;
  if (productId) {
    const convIds = ((await db.orderDraft.findMany({ where: draftWhere as never, select: { conversationId: true } })) as Array<{ conversationId: string }>).map((d) => d.conversationId);
    conversations = new Set(convIds).size;
    const items = (await db.orderItem.findMany({ where: { productId }, select: { orderId: true } })) as Array<{ orderId: string }>;
    const orderIds = [...new Set(items.map((i) => i.orderId))];
    const orders = orderIds.length
      ? ((await db.order.findMany({ where: { workspaceId, id: { in: orderIds }, createdAt: range }, select: { status: true } })) as Array<{ status: string }>)
      : [];
    confirmed = orders.filter((o) => CONFIRMED.includes(o.status)).length;
    delivered = orders.filter((o) => o.status === "DELIVERED").length;
  } else {
    conversations = await db.conversation.count({ where: { workspaceId, createdAt: range } });
    confirmed = await db.order.count({ where: { workspaceId, createdAt: range, status: { in: CONFIRMED as never } } });
    delivered = await db.order.count({ where: { workspaceId, createdAt: range, status: "DELIVERED" } });
  }
  return {
    period: periodOut(p, tz),
    product_code: productCode ?? null,
    conversations,
    drafts_started: drafts,
    drafts_ready: draftsReady,
    orders_confirmed: confirmed,
    orders_delivered: delivered,
    rates: {
      draft_start: rate(drafts, conversations),
      ready: rate(draftsReady, drafts),
      confirm: rate(confirmed, draftsReady),
      delivery: rate(delivered, confirmed),
    },
  };
}

export async function topQuestions(db: Db, workspaceId: string, p: ResolvedPeriod, tz: string, productCode?: string | null) {
  const productId = await productIdByCode(db, workspaceId, productCode);
  let conversationFilter: string[] | undefined;
  if (productId) {
    conversationFilter = ((await db.orderDraft.findMany({ where: { workspaceId, productId } as never, select: { conversationId: true } })) as Array<{ conversationId: string }>).map((d) => d.conversationId);
  }
  const logs =
    productId === null
      ? []
      : ((await db.aIUsageLog.findMany({
          where: {
            workspaceId,
            createdAt: { gte: p.start, lt: p.end },
            intent: { not: null },
            ...(conversationFilter ? { conversationId: { in: conversationFilter } } : {}),
          } as never,
          select: { intent: true, messageId: true },
          take: 100_000,
        })) as Array<{ intent: string | null; messageId: string | null }>);
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const l of logs) {
    if (!l.intent) continue;
    const key = l.messageId ? `${l.messageId}` : `x${seen.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(l.intent, (counts.get(l.intent) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const topics = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([intent, count]) => ({ intent, label_ar: INTENT_LABELS_AR[intent] ?? intent, count, share: total ? Math.round((count / total) * 1000) / 1000 : 0 }));
  return { period: periodOut(p, tz), product_code: productCode ?? null, total, topics };
}

export async function teamPerformance(db: Db, workspaceId: string, p: ResolvedPeriod, tz: string) {
  const res = await getAgentAnalytics(db, workspaceId, { range: "custom", from: p.start.toISOString(), to: p.end.toISOString(), timezone: tz });
  return {
    period: periodOut(p, tz),
    agents: res.agents.map((a) => ({
      agent_ref: agentRef(a.agentId),
      conversations_assigned: a.conversationsAssigned,
      replies_sent: a.repliesSent,
      first_response_median_min: a.firstResponseMedianMinutes === null ? null : Math.round(a.firstResponseMedianMinutes * 10) / 10,
      handoffs_resolved: a.handoffsResolved,
      orders_confirmed: a.ordersLinkedConfirmed,
      // التحويل = طلبات مؤكدة مرتبطة ÷ محادثات مسندة (null بلا محادثات).
      conversion: rate(a.ordersLinkedConfirmed, a.conversationsAssigned),
    })),
  };
}

export async function listReplyTemplates(db: Db, workspaceId: string, productCode?: string | null, limit = 20) {
  const productId = await productIdByCode(db, workspaceId, productCode);
  const faqs =
    productId === null
      ? []
      : ((await db.faq.findMany({
          where: { workspaceId, isActive: true, ...(productId ? { productId } : {}) },
          orderBy: { updatedAt: "desc" },
          take: Math.min(Math.max(limit, 1), 100),
        })) as Array<{ id: string; productId: string | null; category: string | null; question: string; answer: string }>);
  const productIds = [...new Set(faqs.map((f) => f.productId).filter((v): v is string => Boolean(v)))];
  const products = productIds.length
    ? ((await db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })) as Array<{ id: string; sku: string }>)
    : [];
  const skuById = new Map(products.map((x) => [x.id, x.sku]));
  const versions = (await db.campaignContentVersion.findMany({
    where: { workspaceId, status: "APPROVED", templateName: { not: null } } as never,
    select: { templateName: true, templateLanguage: true },
    take: 200,
  })) as Array<{ templateName: string | null; templateLanguage: string | null }>;
  // «template_name» مش «name»: مفتاح name محجوز بحارس البيانات الشخصية (اسم زبون).
  const wa = new Map<string, { template_name: string; language: string }>();
  for (const v of versions) {
    if (!v.templateName) continue;
    const lang = v.templateLanguage ?? "ar";
    wa.set(`${v.templateName}|${lang}`, { template_name: v.templateName.slice(0, 120), language: lang.slice(0, 10) });
  }
  return {
    templates: faqs.map((f) => ({
      template_id: f.id,
      product_code: f.productId ? skuById.get(f.productId) ?? null : null,
      topic: f.category ? f.category.slice(0, 60) : null,
      // أرقام/إيميلات داخل نص تجاري تُستبدل بـ «[…]» — لا رقم يخرج لوكيل.
      question: redactContacts(f.question).slice(0, 500),
      answer: redactContacts(f.answer).slice(0, 2000),
    })),
    whatsapp_templates: [...wa.values()],
  };
}
