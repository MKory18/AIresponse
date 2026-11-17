import type { Permission } from "@/modules/rbac/permissions";

/**
 * «يحتاجك» (2.3، 05-DASHBOARDS §3): **قائمة وحدة** لكل شي بدّه بني آدم — محسوبة من البيانات الموجودة،
 * ولا جدول جديد. مصدر واحد لأربع أماكن عرض: عدّاد الرأس · تبويب «يحتاجك» بالمحادثات · «تحتاج مراجعة» بالطلبات · شريط العطل.
 *
 * - كل بند إله صلاحية (`permission`): ما بيوصل إلا لمن بيقدر يعالجه.
 * - بند «حل» ما إله زر تجاهل: بيختفي لما سببه يروح (طلب انراجع · ربط انصلح).
 * - الوكيل بيضل يرد والمحادثة ببند «يحتاجك» (قرار المالك السابق: كل رسالة إلها رد).
 */

export type AttentionType =
  | "ORDER_REVIEW"
  | "ORDER_CHANGE"
  | "AI_PROMISE"
  | "ASKED_HUMAN"
  | "COMPLAINT"
  | "UNANSWERED"
  | "SEND_FAILED"
  | "READ_FAILED"
  | "OMS_STUCK"
  | "OMS_DOWN"
  | "PAGE_DOWN"
  | "AI_FAILING"
  | "WORKER_DOWN"
  | "SETUP_GAP";

export type Severity = "critical" | "high" | "medium" | "low";

export interface AttentionItem {
  id: string;
  type: AttentionType;
  severity: Severity;
  title: string;
  subtitle: string;
  href: string;
  createdAt: string;
}

export interface AttentionResult {
  items: AttentionItem[];
  counts: { total: number; critical: number };
  banner: { type: AttentionType; title: string; href: string } | null;
}

/** بند قبل فلترة الصلاحية (بيتخبّى بالكاش لكل مساحة؛ الفلترة بتنعمل عند القراءة). */
export interface RawAttentionItem extends AttentionItem {
  permission: Permission;
}

type Rows = Array<Record<string, unknown>>;
type Delegate = { findMany(a: unknown): Promise<Rows>; findFirst(a: unknown): Promise<Record<string, unknown> | null>; findUnique(a: unknown): Promise<Record<string, unknown> | null>; count(a: unknown): Promise<number> };
type Db = Record<string, Delegate>;

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const MIN = 60_000;
const PER_TYPE_LIMIT = 30;

export const UNANSWERED_AFTER_MS = 10 * MIN;
export const OMS_STUCK_AFTER_MS = 15 * MIN;
export const WORKER_STALE_AFTER_MS = 2 * MIN;
const SEND_FAILED_WINDOW_MS = 24 * 60 * MIN;
const AI_FAILING_MIN_FAILURES = 5;
const AI_FAILING_WINDOW = 10;

const iso = (v: unknown, fallback: Date): string => {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : fallback.toISOString();
};
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const ts = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN);

/** كل البنود الخام للمساحة (بلا فلترة صلاحيات). كل فحص بيفشل لحاله بلا ما يوقّف الباقي. */
export async function computeAttention(dbIn: unknown, workspaceId: string, now: Date = new Date()): Promise<RawAttentionItem[]> {
  const db = dbIn as Db;
  const out: RawAttentionItem[] = [];
  const push = (permission: Permission, item: Omit<AttentionItem, "id"> & { id: string }) => out.push({ ...item, permission });
  const safe = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      // فحص واحد فشل (جدول مش جاهز · خطأ مؤقت): نكمّل بالباقي — لوحة «يحتاجك» ما بتقع.
    }
  };

  // 1) طلبات تحتاج مراجعة
  await safe(async () => {
    const rows = await db.order!.findMany({ where: { workspaceId, status: "CONFIRMATION_PENDING" }, orderBy: { createdAt: "desc" }, take: PER_TYPE_LIMIT });
    for (const o of rows)
      push("orders.seal", {
        id: `ORDER_REVIEW:${s(o.id)}`, type: "ORDER_REVIEW", severity: "high",
        title: "طلب يحتاج مراجعة", subtitle: s(o.orderNumber) || "طلب", href: `/orders?order=${s(o.id)}`, createdAt: iso(o.updatedAt ?? o.createdAt, now),
      });
  });

  // 2) تغيير على طلب مثبّت عند الـOMS
  await safe(async () => {
    const rows = await db.orderRevision!.findMany({ where: { workspaceId, omsState: { in: ["NOTE_SENT", "NEEDS_STAFF"] } }, orderBy: { createdAt: "desc" }, take: PER_TYPE_LIMIT });
    const seen = new Set<string>();
    for (const r of rows) {
      const orderId = s(r.orderId);
      if (!orderId || seen.has(orderId)) continue;
      seen.add(orderId);
      push("orders.amend", {
        id: `ORDER_CHANGE:${orderId}`, type: "ORDER_CHANGE", severity: "high",
        title: "تغيير على طلب مثبّت", subtitle: r.omsState === "NEEDS_STAFF" ? "بدّه موظف" : "انبعت للـOMS", href: `/orders?order=${orderId}`, createdAt: iso(r.createdAt, now),
      });
    }
  });

  // 3) محادثات بدها بني آدم (تحويلات مفتوحة): وعد بلا طلب · شكوى · طلب موظف
  await safe(async () => {
    const rows = await db.humanHandoff!.findMany({ where: { workspaceId, status: "OPEN" }, orderBy: { createdAt: "desc" }, take: PER_TYPE_LIMIT * 2 });
    const seen = new Set<string>();
    for (const h of rows) {
      const conv = s(h.conversationId);
      if (!conv || seen.has(conv)) continue;
      seen.add(conv);
      const meta = (h.metadata ?? {}) as Record<string, unknown>;
      const type: AttentionType = meta.aiClaimedNoOrder === true ? "AI_PROMISE" : h.reason === "COMPLAINT" ? "COMPLAINT" : "ASKED_HUMAN";
      const title = type === "AI_PROMISE" ? "الوكيل وعد بتثبيت والبيانات ناقصة" : type === "COMPLAINT" ? "شكوى عميل" : "عميل بدّه موظف";
      push("handoffs.claim", { id: `${type}:${conv}`, type, severity: "high", title, subtitle: "المحادثة", href: `/conversations?id=${conv}`, createdAt: iso(h.createdAt, now) });
    }
  });

  // 4) رسالة عميل بلا رد > 10 دقايق (آخر 24 ساعة)
  await safe(async () => {
    const cutoff = new Date(now.getTime() - UNANSWERED_AFTER_MS);
    const floor = new Date(now.getTime() - SEND_FAILED_WINDOW_MS);
    const convs = await db.conversation!.findMany({
      where: { workspaceId, status: "OPEN", deletedAt: null, lastCustomerMessageAt: { gte: floor, lt: cutoff } },
      orderBy: { lastCustomerMessageAt: "desc" },
      take: PER_TYPE_LIMIT,
    });
    if (convs.length === 0) return;
    const ids = convs.map((c) => s(c.id));
    const replies = await db.message!.findMany({ where: { workspaceId, conversationId: { in: ids }, direction: "OUTBOUND", isNote: false, createdAt: { gte: floor } } });
    for (const c of convs) {
      const lastCustomer = ts(c.lastCustomerMessageAt);
      const answered = replies.some((m) => s(m.conversationId) === s(c.id) && ts(m.createdAt) >= lastCustomer);
      if (answered) continue;
      push("channels.send_human", {
        id: `UNANSWERED:${s(c.id)}`, type: "UNANSWERED", severity: "medium",
        title: "رسالة عميل بلا رد", subtitle: "أكتر من 10 دقايق", href: `/conversations?id=${s(c.id)}`, createdAt: iso(c.lastCustomerMessageAt, now),
      });
    }
  });

  // 5) رسالة صادرة فشل إرسالها (آخر 24 ساعة)
  await safe(async () => {
    const rows = await db.message!.findMany({
      where: { workspaceId, direction: "OUTBOUND", deliveryStatus: "FAILED", isNote: false, createdAt: { gte: new Date(now.getTime() - SEND_FAILED_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
      take: PER_TYPE_LIMIT * 2,
    });
    const seen = new Set<string>();
    for (const m of rows) {
      const conv = s(m.conversationId);
      if (!conv || seen.has(conv)) continue;
      seen.add(conv);
      push("channels.send_human", {
        id: `SEND_FAILED:${conv}`, type: "SEND_FAILED", severity: "medium",
        title: "رسالة ما انبعتت", subtitle: "أعد الإرسال من المحادثة", href: `/conversations?id=${conv}`, createdAt: iso(m.createdAt, now),
      });
    }
  });

  // 6) قراءة محادثة فشلت
  await safe(async () => {
    const rows = await db.conversationReading!.findMany({ where: { workspaceId, status: "FAILED" }, orderBy: { updatedAt: "desc" }, take: PER_TYPE_LIMIT });
    for (const r of rows)
      push("orders.write", {
        id: `READ_FAILED:${s(r.conversationId)}`, type: "READ_FAILED", severity: "medium",
        title: "تعذّرت قراءة المحادثة", subtitle: "أعد القراءة", href: `/conversations?id=${s(r.conversationId)}`, createdAt: iso(r.updatedAt, now),
      });
  });

  // 7) ربط الـOMS: طلب مثبّت ما وصل · الربط واقع
  await safe(async () => {
    const conn = await db.omsConnection!.findUnique({ where: { workspaceId } });
    if (!conn || conn.isActive === false) return;
    const errAt = ts(conn.lastErrorAt);
    const okAt = ts(conn.lastOkAt);
    if (!Number.isNaN(errAt) && (Number.isNaN(okAt) || errAt > okAt)) {
      push("integrations.manage", {
        id: "OMS_DOWN", type: "OMS_DOWN", severity: "critical",
        title: "ربط الـOMS متوقف", subtitle: "الطلبات المثبّتة بتستنى لحد ما ينصلح الربط", href: "/settings/integrations", createdAt: iso(conn.lastErrorAt, now),
      });
    }
    const stuck = await db.order!.findMany({
      where: { workspaceId, sealedAt: { not: null, lt: new Date(now.getTime() - OMS_STUCK_AFTER_MS) }, omsOrderId: null, status: { notIn: ["CANCELLED", "FAILED", "RETURNED", "DELIVERED"] } },
      orderBy: { sealedAt: "asc" },
      take: PER_TYPE_LIMIT,
    });
    for (const o of stuck)
      push("orders.amend", {
        id: `OMS_STUCK:${s(o.id)}`, type: "OMS_STUCK", severity: "high",
        title: "طلب مثبّت ما وصل للـOMS", subtitle: s(o.orderNumber) || "طلب", href: `/orders?order=${s(o.id)}`, createdAt: iso(o.sealedAt, now),
      });
  });

  // 8) صفحة/قناة انقطعت بعد ما كانت شغّالة (لها معرّف خارجي)
  await safe(async () => {
    const rows = await db.channel!.findMany({ where: { workspaceId, OR: [{ status: "ERROR" }, { status: "DISCONNECTED", externalId: { not: null } }] }, take: PER_TYPE_LIMIT });
    for (const c of rows)
      push("channels.connect", {
        id: `PAGE_DOWN:${s(c.id)}`, type: "PAGE_DOWN", severity: "critical",
        title: "صفحة انقطعت", subtitle: s(c.displayName) || "قناة", href: "/channels", createdAt: iso(c.updatedAt, now),
      });
  });

  // 9) الوكيل بيفشل بالرد (≥5 من آخر 10 محاولات)
  await safe(async () => {
    const rows = await db.aIUsageLog!.findMany({ where: { workspaceId, purpose: "RESPONSE" }, orderBy: { createdAt: "desc" }, take: AI_FAILING_WINDOW });
    const failures = rows.filter((r) => r.success === false).length;
    if (failures >= AI_FAILING_MIN_FAILURES)
      push("ai.configure", {
        id: "AI_FAILING", type: "AI_FAILING", severity: "critical",
        title: "الوكيل بيفشل بالرد", subtitle: `${failures} فشل من آخر ${rows.length} محاولة`, href: "/settings/ai", createdAt: iso(rows[0]?.createdAt, now),
      });
  });

  // 10) العامل (الطابور) واقف — نبضة أقدم من دقيقتين
  await safe(async () => {
    const hb = await db.workerHeartbeat!.findFirst({ orderBy: { lastCycleAt: "desc" } });
    if (hb && now.getTime() - ts(hb.lastCycleAt) > WORKER_STALE_AFTER_MS)
      push("ai.configure", {
        id: "WORKER_DOWN", type: "WORKER_DOWN", severity: "critical",
        title: "العامل الخلفي واقف", subtitle: "الرد الآلي والمهام ما بتشتغل", href: "/settings/ai", createdAt: iso(hb.lastCycleAt, now),
      });
  });

  // 11) فجوات إعداد (أهدأ بند)
  await safe(async () => {
    if ((await db.product!.count({ where: { workspaceId, isActive: true } })) === 0)
      push("products.write", { id: "SETUP_GAP:products", type: "SETUP_GAP", severity: "low", title: "ما في منتجات", subtitle: "أضف منتجاتك ليبيع الوكيل", href: "/products", createdAt: now.toISOString() });
    if ((await db.faq!.count({ where: { workspaceId, isActive: true } })) === 0)
      push("knowledge.write", { id: "SETUP_GAP:faq", type: "SETUP_GAP", severity: "low", title: "ما في أسئلة شائعة", subtitle: "أضف أول سؤال ليجاوب الوكيل بدقة", href: "/knowledge", createdAt: now.toISOString() });
  });

  return out;
}

/** فلترة حسب صلاحيات الطالب + ترتيب (الشدة ثم الأحدث) + العدّادات + أعلى عطل حرج لشريط العطل. */
export function attentionFor(raw: readonly RawAttentionItem[], can: (permission: Permission) => boolean): AttentionResult {
  const items: AttentionItem[] = raw
    .filter((r) => can(r.permission))
    .map(({ permission: _p, ...item }) => item)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const critical = items.filter((i) => i.severity === "critical");
  const top = critical[0];
  return {
    items,
    counts: { total: items.length, critical: critical.length },
    banner: top ? { type: top.type, title: top.title, href: top.href } : null,
  };
}

// ─────────── كاش 15 ثانية لكل مساحة (محسوب مش مخزّن) ───────────

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; items: RawAttentionItem[] }>();

export async function getAttention(
  db: unknown,
  workspaceId: string,
  can: (permission: Permission) => boolean,
  opts: { now?: Date; cache?: boolean } = {}
): Promise<AttentionResult> {
  const now = opts.now ?? new Date();
  const useCache = opts.cache !== false;
  let entry = useCache ? cache.get(workspaceId) : undefined;
  if (!entry || now.getTime() - entry.at > CACHE_TTL_MS) {
    entry = { at: now.getTime(), items: await computeAttention(db, workspaceId, now) };
    if (useCache) cache.set(workspaceId, entry);
  }
  return attentionFor(entry.items, can);
}

/** يفرّغ الكاش (للاختبار، ولما حدث يغيّر القائمة فورًا). */
export function clearAttentionCache(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}
