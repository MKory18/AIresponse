import { median } from "@/core/analytics/time";
import { AppError } from "@/core/errors";
import type { Db } from "@/modules/customers/service";
import { dateInZone } from "./format";

/**
 * R2 — إشارات الإعلانات للميديا باير (عقد `replies-mediabuyer.v1` · `GET /api/v1/ad-signals`):
 * لكل إعلان ولكل يوم **أعداد بس** — بلا اسم ولا رقم ولا عنوان ولا معرّف عميل بأي حقل.
 *
 * التعريفات (ثابتة ومكتوبة):
 * - الإعلان = `AttributionTouch` من نوع AD بـ`episodeStart` ورقم إعلان Meta الحقيقي (6–25 رقم). «بداية المحادثة
 *   بتحكم»: كل محادثة بتنحسب مرة وحدة، على أول إعلان فتحها، وباليوم (بتوقيت المساحة) اللي انفتحت فيه.
 * - conversations_started: عدد محادثات الإعلان باليوم.
 * - first_response_p50_min: وسيط (أول رد حقيقي − أول رسالة عميل) لمحادثات الخلية اللي انردّ عليها. null = ما في عيّنة.
 *   الملاحظة الداخلية ورسالة الحملة ما بتنحسب ردًا.
 * - unanswered: محادثات الخلية المفتوحة/المعلّقة وآخر رسالة عميل فيها بلا رد حقيقي بعدها (لحظي — وقت الطلب).
 * - handoffs_by_reason: تحويلات الموظف على محادثات الخلية، مجمّعة بالسبب.
 * - orders_drafted: طلبات محادثات الخلية (أي حالة) + مسودات مفتوحة لسا ما تحوّلت لطلب.
 * - orders_confirmed: منها المثبّت (`sealedAt`) أو اللي وصل «مؤكد» فما فوق (مؤكد · تجهيز · توصيل · تسليم · مرتجع).
 * - **خلية فيها أقل من 5 محادثات بتنحذف كلها** (ما بيصير يُستنتج واحد بعينه).
 */

export const AD_SIGNALS_MIN_BUCKET = 5;
export const AD_SIGNALS_MAX_DAYS_BACK = 31;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_TOUCHES = 20_000;
const MAX_MESSAGES = 100_000;
const AD_ID_RE = /^\d{6,25}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIRMED_STATUSES = new Set(["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"]);

export interface AdSignalItem {
  ad_id: string;
  date: string;
  conversations_started: number;
  first_response_p50_min: number | null;
  unanswered: number;
  handoffs_by_reason: Record<string, number>;
  orders_drafted: number;
  orders_confirmed: number;
}
export interface AdSignalsPage {
  items: AdSignalItem[];
  next_cursor: string | null;
}
export interface AdSignalsQuery {
  since: string | null;
  until?: string | null;
  cursor?: string | null;
  limit?: string | number | null;
}

function bad(message: string, details: unknown[] = []): AppError {
  return new AppError(message, 400, "VALIDATION_FAILED", details);
}

const validDate = (s: string): boolean => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export function encodeCursor(date: string, adId: string): string {
  return Buffer.from(`${date}|${adId}`, "utf8").toString("base64url");
}
function decodeCursor(raw: string): { date: string; adId: string } {
  const [date, adId] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!date || !adId || !validDate(date) || !AD_ID_RE.test(adId)) throw bad("cursor غير صالح", [{ path: "cursor", message: "invalid" }]);
  return { date, adId };
}

export interface ParsedAdSignalsQuery {
  since: string;
  until: string;
  cursor: { date: string; adId: string } | null;
  limit: number;
}

/** يتحقق من الاستعلام (400 VALIDATION_FAILED): since مطلوب وبحد أقصى 31 يوم للخلف · until اختياري · limit 1..200. */
export function parseAdSignalsQuery(q: AdSignalsQuery, today: string): ParsedAdSignalsQuery {
  const since = (q.since ?? "").trim();
  if (!since || !validDate(since)) throw bad("since مطلوب بصيغة YYYY-MM-DD", [{ path: "since", message: "required YYYY-MM-DD" }]);
  if (dayDiff(today, since) > AD_SIGNALS_MAX_DAYS_BACK) {
    throw bad(`since أقدم من ${AD_SIGNALS_MAX_DAYS_BACK} يوم`, [{ path: "since", message: `at most ${AD_SIGNALS_MAX_DAYS_BACK} days back` }]);
  }
  const untilRaw = (q.until ?? "").trim();
  if (untilRaw && !validDate(untilRaw)) throw bad("until بصيغة YYYY-MM-DD", [{ path: "until", message: "YYYY-MM-DD" }]);
  const until = untilRaw || today;
  if (dayDiff(until, since) < 0) throw bad("until قبل since", [{ path: "until", message: "before since" }]);
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== null && String(q.limit).trim() !== "") {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw bad(`limit بين 1 و${MAX_LIMIT}`, [{ path: "limit", message: `1..${MAX_LIMIT}` }]);
    limit = n;
  }
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  return { since, until, cursor, limit };
}

type Touch = { conversationId: string; adId: string | null; kind: string; episodeStart: boolean; occurredAt: Date | string };
type Msg = { conversationId: string; direction: string; createdAt: Date | string };

/** إشارات الإعلانات للمساحة (قراءة بس). `now` للاختبار. */
export async function computeAdSignals(db: Db, workspaceId: string, query: AdSignalsQuery, now = new Date()): Promise<AdSignalsPage> {
  const ws = (await db.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } })) as { timezone?: string } | null;
  const tz = ws?.timezone ?? "UTC";
  const q = parseAdSignalsQuery(query, dateInZone(now, tz));

  // نافذة آمنة بتغطي أي منطقة زمنية (±14 ساعة) ثم الفلترة النهائية باليوم المحلي.
  const from = new Date(Date.parse(`${q.since}T00:00:00Z`) - 14 * 3600_000);
  const to = new Date(Date.parse(`${q.until}T00:00:00Z`) + 24 * 3600_000 + 14 * 3600_000);
  const inRange = (await db.attributionTouch.findMany({
    where: { workspaceId, kind: "AD", episodeStart: true, adId: { not: null }, occurredAt: { gte: from, lte: to } },
    orderBy: { occurredAt: "asc" },
    take: MAX_TOUCHES,
  } as never)) as Touch[];
  if (inRange.length === 0) return { items: [], next_cursor: null };

  // «بداية المحادثة بتحكم»: المحادثة لأول إعلان فتحها (حتى لو قبل النافذة).
  const convIds = [...new Set(inRange.map((t) => t.conversationId))];
  const firsts = (await db.attributionTouch.findMany({
    where: { workspaceId, kind: "AD", episodeStart: true, adId: { not: null }, conversationId: { in: convIds } },
    orderBy: { occurredAt: "asc" },
    take: MAX_TOUCHES,
  } as never)) as Touch[];
  const owner = new Map<string, Touch>();
  for (const t of firsts) if (!owner.has(t.conversationId) && t.adId && AD_ID_RE.test(t.adId)) owner.set(t.conversationId, t);

  const cells = new Map<string, { adId: string; date: string; convs: string[] }>();
  for (const [convId, t] of owner) {
    const date = dateInZone(new Date(t.occurredAt), tz);
    if (date < q.since || date > q.until) continue;
    const key = `${date}|${t.adId}`;
    const cell = cells.get(key) ?? { adId: t.adId!, date, convs: [] };
    cell.convs.push(convId);
    cells.set(key, cell);
  }
  // ما بنكشف خلية صغيرة (خصوصية): أقل من 5 محادثات = محذوفة.
  const kept = [...cells.values()].filter((c) => c.convs.length >= AD_SIGNALS_MIN_BUCKET).sort((a, b) => (a.date === b.date ? (a.adId < b.adId ? -1 : 1) : a.date < b.date ? -1 : 1));
  const after = q.cursor ? kept.filter((c) => c.date > q.cursor!.date || (c.date === q.cursor!.date && c.adId > q.cursor!.adId)) : kept;
  const page = after.slice(0, q.limit);
  if (page.length === 0) return { items: [], next_cursor: null };

  const pageConvs = [...new Set(page.flatMap((c) => c.convs))];
  const [convs, msgs, handoffs, orders, drafts] = await Promise.all([
    db.conversation.findMany({
      where: { workspaceId, id: { in: pageConvs } },
      select: { id: true, status: true, lastCustomerMessageAt: true, lastAgentMessageAt: true },
    }) as Promise<Array<{ id: string; status: string; lastCustomerMessageAt: Date | string | null; lastAgentMessageAt: Date | string | null }>>,
    db.message.findMany({
      where: {
        workspaceId,
        conversationId: { in: pageConvs },
        deletedAt: null,
        isNote: false,
        senderType: { in: ["CUSTOMER", "AI", "HUMAN"] },
        OR: [{ senderId: null }, { senderId: { not: "campaign-system" } }],
      } as never,
      select: { conversationId: true, direction: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: MAX_MESSAGES,
    }) as Promise<Msg[]>,
    db.humanHandoff.findMany({ where: { workspaceId, conversationId: { in: pageConvs } }, select: { conversationId: true, reason: true } }) as Promise<Array<{ conversationId: string; reason: string }>>,
    db.order.findMany({ where: { workspaceId, conversationId: { in: pageConvs } }, select: { id: true, conversationId: true, status: true, sealedAt: true } }) as Promise<
      Array<{ id: string; conversationId: string; status: string; sealedAt: Date | string | null }>
    >,
    db.orderDraft.findMany({ where: { workspaceId, conversationId: { in: pageConvs }, orderId: null }, select: { conversationId: true, state: true } }) as Promise<
      Array<{ conversationId: string; state: string }>
    >,
  ]);

  const convById = new Map(convs.map((c) => [c.id, c]));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) (byConv.get(m.conversationId) ?? byConv.set(m.conversationId, []).get(m.conversationId)!).push(m);

  const firstReplyMin = (id: string): number | null => {
    const list = byConv.get(id) ?? [];
    const first = list.find((m) => m.direction === "INBOUND");
    if (!first) return null;
    const t0 = new Date(first.createdAt).getTime();
    const reply = list.find((m) => m.direction === "OUTBOUND" && new Date(m.createdAt).getTime() >= t0);
    return reply ? (new Date(reply.createdAt).getTime() - t0) / 60_000 : null;
  };
  const isWaiting = (id: string): boolean => {
    const c = convById.get(id);
    if (!c || !["OPEN", "PENDING"].includes(c.status) || !c.lastCustomerMessageAt) return false;
    const cust = new Date(c.lastCustomerMessageAt).getTime();
    const list = byConv.get(id) ?? [];
    return !list.some((m) => m.direction === "OUTBOUND" && new Date(m.createdAt).getTime() >= cust);
  };

  const items: AdSignalItem[] = page.map((cell) => {
    const set = new Set(cell.convs);
    const mins = cell.convs.map(firstReplyMin).filter((v): v is number => v !== null);
    const p50 = median(mins);
    const reasons: Record<string, number> = {};
    for (const h of handoffs) if (set.has(h.conversationId)) reasons[h.reason] = (reasons[h.reason] ?? 0) + 1;
    const cellOrders = orders.filter((o) => set.has(o.conversationId));
    const openDrafts = drafts.filter((d) => set.has(d.conversationId) && d.state !== "EMPTY" && d.state !== "CANCELLED").length;
    return {
      ad_id: cell.adId,
      date: cell.date,
      conversations_started: cell.convs.length,
      first_response_p50_min: p50 === null ? null : Math.round(p50 * 10) / 10,
      unanswered: cell.convs.filter(isWaiting).length,
      handoffs_by_reason: reasons,
      orders_drafted: cellOrders.length + openDrafts,
      orders_confirmed: cellOrders.filter((o) => o.sealedAt || CONFIRMED_STATUSES.has(o.status)).length,
    };
  });

  const last = page[page.length - 1];
  return { items, next_cursor: after.length > page.length ? encodeCursor(last.date, last.adId) : null };
}

