import { z } from "zod";
import { childLogger } from "@/core/logger";
import type { ActorContext, Db } from "@/modules/customers/service";
import { recordAudit } from "@/modules/audit/service";
import { NotFoundError } from "@/core/errors";
import {
  OUTBOUND_EVENT_TYPES,
  targetsForEvent,
  type GenericSystem,
  type OutboundEventType,
} from "./systems";
import { checkSystemUrl, effectiveEventsUrl, getDecryptedConnection, markConnectionResult, validateSystemUrl } from "./connections";
import { findPii } from "./pii-guard";
import { isoInZone } from "./format";
import { newEventId, newRequestId, signZakiPayload, unixSeconds } from "./signing";

/**
 * P12 — صندوق الصادر الموحّد (outbox).
 *
 * كل حدث موقّع أو نداء لنظام آخر يُكتب صفًا أولًا، والعامل يرسله بإعادة
 * محاولة متزايدة. نفس فلسفة أحداث تطبيقات الـ OMS (src/lib/apps/events.ts):
 * - الحدث لا يُرسل أبدًا «داخل» العملية التي سببته: طلب انحفظ لا يفشل لأن
 *   الكليبر واقف.
 * - كل محاولة مسجّلة (ماذا · لوين · كم مرة · شو رجع).
 * - dedupeKey فريد: نفس الحدث لنفس النظام لا يُكتب مرتين، وIdempotency-Key
 *   ثابت لكل نداء فلا يتكرر عند المستقبِل.
 * - لا بيانات شخصية: مخطط حرفي لكل حدث + الحارس — الرفض يمنع الإرسال كله.
 */

const log = childLogger("integrations.outbox");

/**
 * جدول إعادة المحاولة بالثواني: سريع ثم صبور ثم توقف. أول محاولة فورية ثم
 * خمس إعادات (30ث · 2د · 10د · ساعة · 6 ساعات) — نظام واقف لساعات لا يضيّع حدثًا.
 */
export const BACKOFF_SEC = [30, 120, 600, 3600, 21600] as const;
export const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;
export const DELIVERY_TIMEOUT_MS = 10_000;
const STUCK_SENDING_MS = 10 * 60_000;

const channelEnum = z.enum(["whatsapp", "messenger", "instagram", "telegram", "tiktok", "web"]);
const convRef = z.string().regex(/^cv_[a-p]{12}$/);
const count = z.number().int().min(0);

/** مخطط كل حدث صادر — حرفي (strict): لا حقل خارج العقد. */
export const EVENT_SCHEMAS: Record<OutboundEventType, z.ZodTypeAny> = {
  "conversation.coded": z
    .object({ code: z.string().regex(/^[A-Z0-9]{3,12}$/), channel: channelEnum, conversation_ref: convRef })
    .strict(),
  "retarget.result": z
    .object({
      campaign_id: z.string().regex(/^rep_rt_[a-z0-9]{8,40}$/),
      external_ref: z.string().min(1).max(64),
      status: z.enum(["pending_approval", "queued", "running", "completed", "cancelled", "failed"]),
      final: z.boolean(),
      counts: z
        .object({
          eligible: count,
          sent: count,
          delivered: count,
          read: count,
          replied: count,
          ordered: count,
          opted_out: count,
          failed: count,
          excluded: count,
        })
        .strict(),
    })
    .strict(),
  opt_out: z
    .object({ channel: channelEnum, conversation_ref: convRef, code: z.string().regex(/^[A-Z0-9]{3,12}$/).nullable() })
    .strict(),
  "capacity.alert": z
    .object({
      level: z.enum(["warning", "critical", "recovered"]),
      unanswered: count,
      first_response_p50_min: z.number().min(0).nullable(),
      by_channel: z.record(channelEnum, count),
      threshold_unanswered: count,
      threshold_p50_min: count,
    })
    .strict(),
};

type DeliveryRow = {
  id: string;
  workspaceId: string;
  system: string;
  kind: string;
  eventId: string | null;
  type: string;
  method: string;
  url: string;
  body: string;
  idempotencyKey: string | null;
  dedupeKey: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date | string | null;
  responseCode: number | null;
  error: string | null;
  deliveredAt: Date | string | null;
  createdAt: Date | string;
};

interface DeliveryModel {
  create(a: unknown): Promise<unknown>;
  findFirst(a: unknown): Promise<unknown>;
  findMany(a: unknown): Promise<unknown>;
  findUnique(a: unknown): Promise<unknown>;
  update(a: unknown): Promise<unknown>;
  updateMany(a: unknown): Promise<{ count: number }>;
  count(a: unknown): Promise<number>;
}

function deliveries(db: Db): DeliveryModel | null {
  return ((db as unknown as { integrationDelivery?: DeliveryModel }).integrationDelivery ?? null);
}

async function workspaceTimezone(db: Db, workspaceId: string): Promise<string> {
  try {
    const ws = (await (db as unknown as { workspace?: { findUnique: (a: unknown) => Promise<unknown> } }).workspace?.findUnique({
      where: { id: workspaceId },
      select: { timezone: true },
    })) as { timezone?: string } | null | undefined;
    return ws?.timezone || "UTC";
  } catch {
    return "UTC";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}

export interface EmitEventInput {
  workspaceId: string;
  type: OutboundEventType;
  data: Record<string, unknown>;
  /** مفتاح ثابت لهذا الحدث (مثلًا محادثة + حلقة) — يمنع التكرار. */
  dedupeKey: string;
  occurredAt?: Date;
}

/**
 * يكتب الحدث لكل نظام مستقبِل مضبوط (رابط + سر توقيع + مفعّل). لا يرمي
 * أبدًا: إعلان ما حصل لا يقدر يلغي ما حصل. يرجّع عدد الصفوف المكتوبة.
 */
export async function emitIntegrationEvent(db: Db, input: EmitEventInput): Promise<number> {
  try {
    const model = deliveries(db);
    if (!model) return 0;
    if (!OUTBOUND_EVENT_TYPES.includes(input.type)) return 0;
    const parsed = EVENT_SCHEMAS[input.type].safeParse(input.data);
    if (!parsed.success) {
      log.warn({ type: input.type, issues: parsed.error.issues.map((i) => i.path.join(".")) }, "integration_event_invalid");
      return 0;
    }
    const findings = findPii(parsed.data);
    if (findings.length > 0) {
      log.error({ type: input.type, findings: findings.map((f) => `${f.kind}@${f.path}`) }, "integration_event_pii_blocked");
      return 0;
    }
    const tz = await workspaceTimezone(db, input.workspaceId);
    let written = 0;
    for (const system of targetsForEvent(input.type)) {
      const conn = await getDecryptedConnection(db, input.workspaceId, system);
      if (!conn || !conn.enabled || !conn.eventsSecret) continue;
      const url = effectiveEventsUrl(system, conn.baseUrl, conn.eventsUrl);
      if (!url || !validateSystemUrl(url).ok) continue;
      const eventId = newEventId();
      const body = JSON.stringify({
        event_id: eventId,
        type: input.type,
        occurred_at: isoInZone(input.occurredAt ?? new Date(), tz),
        data: parsed.data,
      });
      try {
        await model.create({
          data: {
            workspaceId: input.workspaceId,
            system,
            kind: "event",
            eventId,
            type: input.type,
            method: "POST",
            url,
            body,
            dedupeKey: `${system}:${input.type}:${input.dedupeKey}`,
            status: "PENDING",
            nextAttemptAt: new Date(),
          },
        });
        written += 1;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // مكتوب سابقًا = نجاح
      }
    }
    return written;
  } catch (err) {
    log.error({ err, type: input.type }, "integration_event_emit_failed");
    return 0;
  }
}

/** هل الحدث (بمفتاحه) بصندوق الصادر لهالنظام — جديد أو من محاولة سابقة؟ */
export async function eventQueued(db: Db, workspaceId: string, system: GenericSystem, type: OutboundEventType, dedupeKey: string): Promise<boolean> {
  const model = deliveries(db);
  if (!model) return false;
  const row = await model.findFirst({ where: { workspaceId, dedupeKey: `${system}:${type}:${dedupeKey}` } });
  return Boolean(row);
}

export interface SystemCallInput {
  workspaceId: string;
  system: GenericSystem;
  /** اسم النداء بالعقد (usage-costs · alerts · tasks · ideas). */
  type: string;
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  dedupeKey: string;
}

/** نداء POST لنظام آخر عبر الصندوق (توكن الاتصال يُضاف وقت الإرسال فقط). */
export async function enqueueSystemCall(db: Db, input: SystemCallInput): Promise<boolean> {
  try {
    const model = deliveries(db);
    if (!model) return false;
    const conn = await getDecryptedConnection(db, input.workspaceId, input.system);
    if (!conn || !conn.enabled || !conn.baseUrl || !conn.token) return false;
    const findings = findPii(input.body);
    if (findings.length > 0) {
      log.error({ system: input.system, type: input.type, findings: findings.map((f) => `${f.kind}@${f.path}`) }, "integration_call_pii_blocked");
      return false;
    }
    const url = `${conn.baseUrl.replace(/\/+$/, "")}${input.path}`;
    if (!validateSystemUrl(url).ok) return false;
    try {
      await model.create({
        data: {
          workspaceId: input.workspaceId,
          system: input.system,
          kind: "call",
          type: input.type,
          method: "POST",
          url,
          body: JSON.stringify(input.body),
          idempotencyKey: input.idempotencyKey,
          dedupeKey: `${input.system}:${input.type}:${input.dedupeKey}`,
          status: "PENDING",
          nextAttemptAt: new Date(),
        },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return true;
      throw err;
    }
  } catch (err) {
    log.error({ err, system: input.system, type: input.type }, "integration_call_enqueue_failed");
    return false;
  }
}

function nextTry(attempt: number, error: string, code: number | null) {
  const exhausted = attempt >= MAX_ATTEMPTS;
  return {
    status: exhausted ? "FAILED" : "PENDING",
    attempts: attempt,
    responseCode: code,
    error: error.slice(0, 300),
    nextAttemptAt: exhausted ? null : new Date(Date.now() + BACKOFF_SEC[attempt - 1] * 1000),
  };
}

export interface DeliverOptions {
  limit?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface DeliverResult {
  sent: number;
  retrying: number;
  failed: number;
  cancelled: number;
}

/** يرسل صفًا واحدًا (بعد حجزه). يرجّع نتيجته. */
async function deliverRow(db: Db, row: DeliveryRow, fetchImpl: typeof fetch): Promise<"OK" | "RETRY" | "FAILED" | "CANCELLED"> {
  const model = deliveries(db)!;
  const attempt = row.attempts + 1;
  const system = row.system as GenericSystem;
  const conn = await getDecryptedConnection(db, row.workspaceId, system);
  if (!conn || !conn.enabled) {
    await model.update({ where: { id: row.id }, data: { status: "CANCELLED", error: "CONNECTION_DISABLED", nextAttemptAt: null } });
    return "CANCELLED";
  }
  const urlCheck = await checkSystemUrl(row.url);
  if (!urlCheck.ok) {
    if (urlCheck.transient) {
      await model.update({ where: { id: row.id }, data: nextTry(attempt, "DNS_RESOLUTION_FAILED", null) });
      return attempt >= MAX_ATTEMPTS ? "FAILED" : "RETRY";
    }
    await model.update({ where: { id: row.id }, data: { status: "FAILED", attempts: attempt, error: "URL_REJECTED", nextAttemptAt: null } });
    return "FAILED";
  }
  const requestId = newRequestId();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "zaki-replies/1.0",
    "x-request-id": requestId,
  };
  if (row.kind === "event") {
    if (!conn.eventsSecret) {
      // لا نرسل بلا توقيع أبدًا — وإلا علّمنا المستقبِل يقبل غير الموقّع.
      await model.update({ where: { id: row.id }, data: nextTry(attempt, "EVENTS_SECRET_MISSING", null) });
      return attempt >= MAX_ATTEMPTS ? "FAILED" : "RETRY";
    }
    const ts = unixSeconds();
    headers["x-zaki-event"] = row.type;
    headers["x-zaki-delivery"] = row.id;
    headers["x-zaki-timestamp"] = ts;
    headers["x-zaki-signature"] = signZakiPayload(conn.eventsSecret, ts, row.body);
  } else {
    if (!conn.token) {
      await model.update({ where: { id: row.id }, data: nextTry(attempt, "TOKEN_MISSING", null) });
      return attempt >= MAX_ATTEMPTS ? "FAILED" : "RETRY";
    }
    headers.authorization = `Bearer ${conn.token}`;
    if (row.idempotencyKey) headers["idempotency-key"] = row.idempotencyKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(row.url, {
      method: row.method,
      headers,
      body: row.body,
      signal: controller.signal,
      redirect: "manual", // رابط يحوّل = رابط يشير لمكان تاني
    });
    const status = res.status;
    // 409 مع مفتاح عدم التكرار = «استلمته قبل» → نجاح.
    if ((status >= 200 && status < 300) || status === 409) {
      await model.update({
        where: { id: row.id },
        data: { status: "OK", attempts: attempt, responseCode: status, deliveredAt: new Date(), nextAttemptAt: null, error: null },
      });
      await markConnectionResult(db, row.workspaceId, system, { ok: true });
      return "OK";
    }
    // شكل مرفوض نهائيًا: إعادة المحاولة لن تصلحه.
    if (status === 400 || status === 422) {
      await model.update({
        where: { id: row.id },
        data: { status: "FAILED", attempts: attempt, responseCode: status, error: `HTTP ${status}`, nextAttemptAt: null },
      });
      await markConnectionResult(db, row.workspaceId, system, { ok: false, error: `${row.type}: HTTP ${status}` });
      return "FAILED";
    }
    const next = nextTry(attempt, `HTTP ${status}`, status);
    await model.update({ where: { id: row.id }, data: next });
    await markConnectionResult(db, row.workspaceId, system, { ok: false, error: `${row.type}: HTTP ${status}` });
    return next.status === "FAILED" ? "FAILED" : "RETRY";
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
    const next = nextTry(attempt, reason, null);
    await model.update({ where: { id: row.id }, data: next });
    await markConnectionResult(db, row.workspaceId, system, { ok: false, error: `${row.type}: ${reason}` });
    return next.status === "FAILED" ? "FAILED" : "RETRY";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * يرسل الصفوف المستحقة (الأقدم أولًا). آمن مع أكثر من عامل: كل صف يُحجز
 * بانتقال PENDING → SENDING ذري، وصف عالق بـ SENDING (عامل مات) يرجع
 * PENDING بعد 10 دقائق — والإرسال المكرر محمي بمفتاح الحدث/عدم التكرار.
 */
export async function deliverDueIntegrations(db: Db, opts: DeliverOptions = {}): Promise<DeliverResult> {
  const model = deliveries(db);
  const result: DeliverResult = { sent: 0, retrying: 0, failed: 0, cancelled: 0 };
  if (!model) return result;
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;

  await model.updateMany({
    where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
    data: { status: "PENDING" },
  });

  const due = (await model.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 25,
  })) as DeliveryRow[];

  for (const row of due) {
    const claimed = await model.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "SENDING" } });
    if (claimed.count !== 1) continue; // عامل آخر أخذه
    try {
      const outcome = await deliverRow(db, row, fetchImpl);
      if (outcome === "OK") result.sent += 1;
      else if (outcome === "RETRY") result.retrying += 1;
      else if (outcome === "FAILED") result.failed += 1;
      else result.cancelled += 1;
    } catch (err) {
      log.error({ err, deliveryId: row.id }, "integration_delivery_crashed");
      await model.update({ where: { id: row.id }, data: nextTry(row.attempts + 1, "INTERNAL", null) }).catch(() => {});
      result.retrying += 1;
    }
  }
  if (due.length > 0) log.info({ ...result, due: due.length }, "integration_deliveries_processed");
  return result;
}

export interface DeliveryView {
  id: string;
  system: string;
  kind: string;
  type: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
}

const iso = (v: Date | string | null): string | null => (v ? new Date(v).toISOString() : null);

/** آخر عمليات الإرسال (بلا نص الطلب ولا الرابط الكامل). */
export async function listDeliveries(
  db: Db,
  workspaceId: string,
  filter: { system?: string; status?: string; limit?: number } = {}
): Promise<DeliveryView[]> {
  const model = deliveries(db);
  if (!model) return [];
  const rows = (await model.findMany({
    where: {
      workspaceId,
      ...(filter.system ? { system: filter.system } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
  })) as DeliveryRow[];
  return rows.map((r) => ({
    id: r.id,
    system: r.system,
    kind: r.kind,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    responseCode: r.responseCode,
    error: r.error,
    createdAt: iso(r.createdAt)!,
    deliveredAt: iso(r.deliveredAt),
    nextAttemptAt: iso(r.nextAttemptAt),
  }));
}

export async function deliveryStats(db: Db, workspaceId: string, system: string): Promise<{ pending: number; failed: number }> {
  const model = deliveries(db);
  if (!model) return { pending: 0, failed: 0 };
  const [pending, failed] = await Promise.all([
    model.count({ where: { workspaceId, system, status: { in: ["PENDING", "SENDING"] } } }),
    model.count({ where: { workspaceId, system, status: "FAILED" } }),
  ]);
  return { pending, failed };
}

/** إعادة محاولة يدوية لصف فشل (بعد تصليح الإعداد مثلًا). */
export async function retryDelivery(db: Db, ctx: ActorContext, id: string): Promise<void> {
  const model = deliveries(db);
  if (!model) throw new NotFoundError("Delivery");
  const row = (await model.findUnique({ where: { id } })) as DeliveryRow | null;
  if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError("Delivery");
  if (row.status === "OK") return;
  await model.update({ where: { id }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), error: null } });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "integration.delivery_retried",
    entityType: "IntegrationDelivery",
    entityId: id,
    metadata: { system: row.system, type: row.type },
  });
}
