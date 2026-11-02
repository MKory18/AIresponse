import { median } from "@/core/analytics/time";
import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";
import { channelKey, isoInZone } from "./format";
import { emitIntegrationEvent, enqueueSystemCall } from "./outbox";
import { getIntegrationSettings } from "./settings";

/**
 * P12 — قدرة الرد (عقد الميديا باير IN03 §2):
 *   GET {REPLIES}/api/v1/capacity →
 *   {"unanswered": 37, "first_response_p50_min": 6, "by_channel": {"whatsapp": 30, "messenger": 7}, "at": "…+03:00"}
 *
 * التعريفات (ثابتة ومكتوبة):
 * - unanswered: محادثة مفتوحة، آخر رسالة زبون خلال آخر 24 ساعة، وبعدها ما
 *   طلع أي رد (ذكاء أو موظف). الملاحظات الداخلية لا تُعد ردًا.
 * - first_response_p50_min: وسيط زمن الرد على «دفعة» رسائل الزبون (أول
 *   رسالة زبون بعد آخر رد) خلال آخر 24 ساعة، بالدقائق. null = ما في عيّنة.
 * - by_channel: الرسائل المنتظرة لكل قناة (أسماء العقد).
 * الأرقام من قاعدة البيانات مباشرة — نفس مصدر الشاشات، بلا تقدير.
 */

const log = childLogger("integrations.capacity");

export const CAPACITY_WINDOW_HOURS = 24;
const MAX_CONVERSATIONS = 5000;
const MAX_MESSAGES = 50_000;

export interface CapacitySnapshot {
  unanswered: number;
  first_response_p50_min: number | null;
  by_channel: Record<string, number>;
  at: string;
}

/**
 * لب القدرة (مشترك بين /api/v1/capacity وأدوات Hermes وملخص الصندوق).
 *
 * «بلا رد» = محادثة مفتوحة/معلّقة، آخر رسالة زبون خلال 24 ساعة، وما طلع بعدها
 * رد حقيقي (ذكاء أو موظف). الحقول المختصرة بالمحادثة سريعة لكن رسالة حملة
 * تسويقية (أو ملاحظة) بتحدّث lastAgentMessageAt وبتخفي زبون منتظر — فأي
 * محادثة «شكلها مردود عليها» بنتأكد من رسائلها: في رد حقيقي بعد آخر رسالة
 * للزبون؟ (لا ملاحظة داخلية ولا رسالة حملة ولا نظام).
 */
export async function capacityCore(
  db: Db,
  workspaceId: string,
  now = new Date(),
  channelIds?: string[]
): Promise<{ unanswered: number; byChannel: Record<string, number>; responseMinutes: number[] }> {
  const since = new Date(now.getTime() - CAPACITY_WINDOW_HOURS * 3600_000);
  const convs = (await db.conversation.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      status: { in: ["OPEN", "PENDING"] },
      lastCustomerMessageAt: { gte: since },
      ...(channelIds ? { channelId: { in: channelIds } } : {}),
    },
    select: { id: true, channelId: true, lastCustomerMessageAt: true, lastAgentMessageAt: true },
    take: MAX_CONVERSATIONS,
  })) as Array<{ id: string; channelId: string; lastCustomerMessageAt: Date | string | null; lastAgentMessageAt: Date | string | null }>;

  const waiting: typeof convs = [];
  const looksAnswered: Array<(typeof convs)[number] & { cust: number }> = [];
  for (const c of convs) {
    const cust = c.lastCustomerMessageAt ? new Date(c.lastCustomerMessageAt).getTime() : NaN;
    const agent = c.lastAgentMessageAt ? new Date(c.lastAgentMessageAt).getTime() : NaN;
    if (!Number.isFinite(cust)) continue;
    if (Number.isFinite(agent) && agent >= cust) looksAnswered.push({ ...c, cust });
    else waiting.push(c);
  }
  if (looksAnswered.length > 0) {
    // OCR-2026-10-16: Math.min(...values) انفجر المكدس بما فوق آلاف المحادثات —
    // حلقة تدقيق بسيطة بدل الانتشار.
    let minTs = Number.POSITIVE_INFINITY;
    for (const c of looksAnswered) if (c.cust < minTs) minTs = c.cust;
    if (!Number.isFinite(minTs)) minTs = Date.now();
    const minCust = new Date(minTs);
    const replies = (await db.message.findMany({
      where: {
        workspaceId,
        conversationId: { in: looksAnswered.map((c) => c.id) },
        createdAt: { gte: minCust },
        deletedAt: null,
        isNote: false,
        senderType: { in: ["AI", "HUMAN"] },
        OR: [{ senderId: null }, { senderId: { not: "campaign-system" } }],
      } as never,
      select: { conversationId: true, createdAt: true },
      take: MAX_MESSAGES,
    })) as Array<{ conversationId: string; createdAt: Date | string }>;
    const lastReply = new Map<string, number>();
    for (const r of replies) {
      const t = new Date(r.createdAt).getTime();
      if (t > (lastReply.get(r.conversationId) ?? -Infinity)) lastReply.set(r.conversationId, t);
    }
    for (const c of looksAnswered) {
      const replied = lastReply.get(c.id);
      if (replied === undefined || replied < c.cust) waiting.push(c);
    }
  }

  const ids = [...new Set(waiting.map((c) => c.channelId))];
  const channels = ids.length
    ? ((await db.channel.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } })) as Array<{ id: string; type: string }>)
    : [];
  const typeById = new Map(channels.map((c) => [c.id, c.type]));
  const byChannel: Record<string, number> = {};
  for (const c of waiting) {
    const key = channelKey(typeById.get(c.channelId));
    byChannel[key] = (byChannel[key] ?? 0) + 1;
  }

  // زمن الرد على كل دفعة رسائل زبون خلال النافذة (الأحدث أولًا إذا انقصّت العيّنة).
  const msgs = (
    (await db.message.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since, lte: now },
        deletedAt: null,
        isNote: false,
        senderType: { in: ["CUSTOMER", "AI", "HUMAN"] },
        // رسالة حملة تسويقية ليست «ردًا» على زبون منتظر.
        OR: [{ senderId: null }, { senderId: { not: "campaign-system" } }],
        ...(channelIds ? { conversationId: { in: convs.map((c) => c.id) } } : {}),
      } as never,
      select: { conversationId: true, direction: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: MAX_MESSAGES,
    })) as Array<{ conversationId: string; direction: string; createdAt: Date | string }>
  ).reverse();
  const open = new Map<string, number>();
  const responseMinutes: number[] = [];
  for (const m of msgs) {
    const t = new Date(m.createdAt).getTime();
    if (m.direction === "INBOUND") {
      if (!open.has(m.conversationId)) open.set(m.conversationId, t);
    } else {
      const started = open.get(m.conversationId);
      if (started !== undefined) {
        responseMinutes.push((t - started) / 60_000);
        open.delete(m.conversationId);
      }
    }
  }
  return { unanswered: waiting.length, byChannel, responseMinutes };
}

export async function computeCapacity(db: Db, workspaceId: string, now = new Date()): Promise<CapacitySnapshot> {
  const ws = (await db.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } })) as { timezone?: string } | null;
  const core = await capacityCore(db, workspaceId, now);
  const p50 = median(core.responseMinutes);
  return {
    unanswered: core.unanswered,
    first_response_p50_min: p50 === null ? null : Math.round(p50 * 10) / 10,
    by_channel: core.byChannel,
    at: isoInZone(now, ws?.timezone),
  };
}

export type CapacityLevel = "ok" | "warning" | "critical";

export function capacityLevel(
  snap: Pick<CapacitySnapshot, "unanswered" | "first_response_p50_min">,
  t: { unanswered: number; p50: number; multiplier: number }
): CapacityLevel {
  const p50 = snap.first_response_p50_min ?? 0;
  if (snap.unanswered >= t.unanswered * t.multiplier || p50 >= t.p50 * t.multiplier) return "critical";
  if (snap.unanswered >= t.unanswered || p50 >= t.p50) return "warning";
  return "ok";
}

type DeliveryRow = { body: string; createdAt: Date | string; eventId: string | null };

/** آخر مستوى إنذار مُرسل (من صندوق الصادر نفسه — لا حالة مخفية بمكان آخر). */
async function lastAlert(db: Db, workspaceId: string): Promise<{ level: string; at: number; eventId: string | null } | null> {
  const row = (await (db as unknown as { integrationDelivery?: { findFirst: (a: unknown) => Promise<unknown> } }).integrationDelivery?.findFirst({
    where: { workspaceId, type: "capacity.alert" },
    orderBy: { createdAt: "desc" },
    select: { body: true, createdAt: true, eventId: true },
  })) as DeliveryRow | null | undefined;
  if (!row) return null;
  try {
    const level = String((JSON.parse(row.body) as { data?: { level?: string } }).data?.level ?? "");
    return { level, at: new Date(row.createdAt).getTime(), eventId: row.eventId };
  } catch {
    return null;
  }
}

const REALERT_MS = 60 * 60_000;

/**
 * يقيّم القدرة ويرسل capacity.alert للميديا باير والجسر (وإنذار للأزمات
 * عند «حرج»): مرة لكل مستوى بالساعة، و«recovered» مرة عند الرجوع للطبيعي.
 */
export async function evaluateCapacityAlerts(db: Db, workspaceId: string, now = new Date()): Promise<CapacityLevel> {
  const settings = await getIntegrationSettings(db, workspaceId);
  const snap = await computeCapacity(db, workspaceId, now);
  const level = capacityLevel(snap, {
    unanswered: settings.capacityUnansweredWarn,
    p50: settings.capacityP50WarnMin,
    multiplier: settings.capacityCriticalMultiplier,
  });
  const prev = await lastAlert(db, workspaceId);
  const data = {
    unanswered: snap.unanswered,
    first_response_p50_min: snap.first_response_p50_min,
    by_channel: snap.by_channel,
    threshold_unanswered: settings.capacityUnansweredWarn,
    threshold_p50_min: settings.capacityP50WarnMin,
  };
  const hourBucket = Math.floor(now.getTime() / REALERT_MS);
  if (level === "ok") {
    if (prev && (prev.level === "warning" || prev.level === "critical")) {
      await emitIntegrationEvent(db, {
        workspaceId,
        type: "capacity.alert",
        data: { level: "recovered", ...data },
        dedupeKey: `recovered:${prev.eventId ?? prev.at}`,
        occurredAt: now,
      });
    }
    return level;
  }
  const sameAndRecent = prev && prev.level === level && now.getTime() - prev.at < REALERT_MS;
  if (!sameAndRecent) {
    const n = await emitIntegrationEvent(db, {
      workspaceId,
      type: "capacity.alert",
      data: { level, ...data },
      // المفتاح بيربط الإنذار بآخر إنذار قبله: عاملين بنفس اللحظة = مفتاح واحد،
      // بس «رجع طبيعي ← إنذار» بنفس الساعة = إنذار جديد ما بينبلع.
      dedupeKey: `${level}:${hourBucket}:${prev?.eventId ?? "first"}`,
      occurredAt: now,
    });
    if (level === "critical") {
      await enqueueSystemCall(db, {
        workspaceId,
        system: "crisis",
        type: "alerts",
        path: "/api/v1/alerts",
        body: {
          external_ref: `rep-cap-${hourBucket}`,
          type: "replies_capacity_critical",
          severity: "high",
          unanswered: snap.unanswered,
          first_response_p50_min: snap.first_response_p50_min,
          message: `ضغط رسائل حرج: ${snap.unanswered} محادثة بلا رد · وسيط أول رد ${snap.first_response_p50_min ?? "—"} دقيقة`,
        },
        idempotencyKey: `rep-cap-${workspaceId.slice(-8)}-${hourBucket}`,
        dedupeKey: `cap:${hourBucket}`,
      });
    }
    log.info({ workspaceId, level, unanswered: snap.unanswered, written: n }, "capacity_alert_evaluated");
  }
  return level;
}
