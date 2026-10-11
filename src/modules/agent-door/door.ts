import { z } from "zod";
import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { rateLimitDb } from "@/core/api/rate-limit";
import type { Db } from "@/modules/customers/service";
import { isoInZone } from "@/modules/integrations/format";
import { findPii } from "@/modules/integrations/pii-guard";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import type { TokenRow } from "@/modules/integrations/tokens";
import { resolvePeriod } from "./period";
import { REPLIES_VERSION } from "./status";
import { countDraftsSince, findDraftByKey } from "./drafts";
import { TOOL_BY_NAME, draftOutputFromRow, draftReviewUrl, risksForScopes, toolManifest, toolsForScopes, type ToolMeta } from "./tools";

/**
 * P12 — باب الوكلاء (agent-door/v1) لنظام الردود.
 *
 *   GET  /api/agent/tools  → دليل الأدوات المسموحة لهالتوكن بس
 *   POST /api/agent/call   → {tool, input, dry_run} → {status, data, meta, request_id}
 *
 * ترتيب الفحص (مثل الجسر IN03 §4 من جهة النظام): التوكن ← الإيقاف ← الأداة ←
 * الدرجة ← حد الأداة ← المدخلات (حرفي) ← مفتاح عدم التكرار ← سقف المسودات
 * اليومي ← التنفيذ ← المخرج مقابل مخططه حرفيًا ← حارس البيانات الشخصية ←
 * سجل النداء. أي فشل = خطأ موحّد بالعربي، ولا رد خارج مخططه يطلع أبدًا.
 */

const log = childLogger("agent-door");

export const DOOR_CONTRACT = "agent-door/v1";
export const DOOR_SYSTEM = "replies";

export class DoorError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly details: Array<{ path: string; message: string }> = []
  ) {
    super(message);
  }
}

export interface DoorErrorBody {
  status: "error";
  error: { code: string; message: string; details: Array<{ path: string; message: string }> };
  request_id: string;
}

export function doorErrorBody(err: DoorError, requestId: string): DoorErrorBody {
  return { status: "error", error: { code: err.code, message: err.message, details: err.details }, request_id: requestId };
}

/** X-Agent-Ref: مرجع الوكيل (hermes:zaki) — بشكل مضبوط وإلا null (للسجل بس). */
export function sanitizeAgentRef(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  return v && /^[a-z0-9_\-]{1,32}(:[a-z0-9_\-]{1,32})?$/i.test(v) ? v.toLowerCase() : null;
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

async function workspaceTz(db: Db, workspaceId: string): Promise<string> {
  const ws = (await db.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } })) as { timezone?: string | null } | null;
  return ws?.timezone || "UTC";
}

/** زر الإيقاف بباب النظام (الجزء التالت §11 مستوى 4): النظام بيرفض توكن الجسر. */
export async function assertDoorOpen(db: Db, token: TokenRow): Promise<void> {
  const settings = await getIntegrationSettings(db, token.workspaceId);
  if (settings.agentDoorPaused) throw new DoorError(401, "UNAUTHORIZED", "باب الوكلاء موقوف من إعدادات الردود");
  if (risksForScopes(token.scopes).length === 0) throw new DoorError(403, "RISK_NOT_ALLOWED", "هالتوكن ما إله صلاحية على باب الوكلاء");
}

export async function buildToolDirectory(db: Db, token: TokenRow, now = new Date()) {
  await assertDoorOpen(db, token);
  const tz = await workspaceTz(db, token.workspaceId);
  return {
    contract: DOOR_CONTRACT,
    system: DOOR_SYSTEM,
    system_version: REPLIES_VERSION,
    generated_at: isoInZone(now, tz),
    tools: toolsForScopes(token.scopes).map(toolManifest),
  };
}

const callBodySchema = z.object({
  tool: z.string().min(1).max(64),
  input: z.unknown().optional(),
  dry_run: z.boolean().optional(),
});

function zodDetails(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.slice(0, 20).map((i) => ({ path: i.path.join(".") || "$", message: i.message }));
}

function appErrorToDoor(err: AppError): DoorError {
  if (err.statusCode === 429 || err.code === "RATE_LIMITED") return new DoorError(429, "RATE_LIMITED", "فوق حد الطلبات");
  if (err.statusCode >= 400 && err.statusCode < 500) {
    const details = Array.isArray(err.details)
      ? (err.details as Array<{ path?: unknown; message?: unknown }>).slice(0, 20).map((d) => ({ path: String(d.path ?? "$"), message: String(d.message ?? err.code) }))
      : [{ path: "$", message: err.code }];
    return new DoorError(422, "VALIDATION_FAILED", err.message, details);
  }
  return new DoorError(500, "INTERNAL", "خطأ داخلي");
}

const KIND_BY_TOOL: Record<string, string> = {
  draft_reply_template: "reply_template",
  draft_retarget_campaign: "retarget_campaign",
};

export interface CallInput {
  token: TokenRow;
  body: unknown;
  requestId: string;
  agentRef: string | null;
  idempotencyKey: string | null;
  now?: Date;
}

export interface CallOk {
  status: "ok" | "draft_created" | "dry_run";
  data: unknown;
  meta: {
    system: string;
    source: string;
    as_of: string;
    period: { from: string; to: string; label: string } | null;
    sample: number | null;
    stale: boolean;
    links: Array<{ title_ar: string; url: string }>;
  };
  request_id: string;
}

async function logCall(
  db: Db,
  row: { workspaceId: string; tokenId: string; tool: string; risk: string; status: string; errorCode: string | null; requestId: string; agentRef: string | null; dryRun: boolean; latencyMs: number }
): Promise<void> {
  try {
    await (db as unknown as { agentCallLog: { create: (a: unknown) => Promise<unknown> } }).agentCallLog.create({ data: row });
  } catch (err) {
    log.warn({ err, tool: row.tool }, "agent_call_log_failed");
  }
}

function buildMeta(m: ToolMeta | undefined, tz: string, now: Date): CallOk["meta"] {
  return {
    system: DOOR_SYSTEM,
    source: m?.source ?? "computed",
    as_of: isoInZone(now, tz),
    period: m?.period ?? null,
    sample: m?.sample ?? null,
    stale: false,
    links: m?.links ?? [],
  };
}

/**
 * نداء أداة. يرجّع الرد الناجح أو يرمي DoorError (المسار بيحوّله للشكل
 * الموحّد). كل نداء — ناجح أو مرفوض بعد التوكن — بيتسجّل بلا مدخلات.
 */
export async function callAgentTool(db: Db, input: CallInput): Promise<CallOk> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const token = input.token;
  let toolName = "invalid";
  let risk = "unknown";
  let dryRun = false;
  try {
    await assertDoorOpen(db, token);
    const parsedBody = callBodySchema.safeParse(input.body);
    if (!parsedBody.success) throw new DoorError(422, "VALIDATION_FAILED", "شكل النداء غلط: {tool, input, dry_run}", zodDetails(parsedBody.error));
    const body = parsedBody.data;
    toolName = /^[a-z0-9_]{1,48}$/.test(body.tool) ? body.tool : "invalid";
    const tool = TOOL_BY_NAME.get(body.tool);
    if (!tool) throw new DoorError(404, "TOOL_NOT_FOUND", `الأداة ${toolName} مش موجودة`);
    risk = tool.risk;
    if (!risksForScopes(token.scopes).includes(tool.risk)) {
      throw new DoorError(403, "RISK_NOT_ALLOWED", `هالأداة (${tool.risk}) مش مسموحة لهالتوكن`);
    }
    dryRun = tool.dry_run && body.dry_run === true;

    try {
      await rateLimitDb(`agent:${token.id}:${tool.name}`, tool.rate_limit_per_min, 60_000);
    } catch (err) {
      if (err instanceof AppError && err.code === "RATE_LIMITED") throw new DoorError(429, "RATE_LIMITED", `فوق حد ${tool.rate_limit_per_min} نداء بالدقيقة لهالأداة`);
      throw err;
    }

    const parsedInput = tool.input.safeParse(body.input ?? {});
    if (!parsedInput.success) throw new DoorError(422, "VALIDATION_FAILED", "مدخلات الأداة غلط", zodDetails(parsedInput.error));

    const tz = await workspaceTz(db, token.workspaceId);
    const idemKey = input.idempotencyKey?.trim() || null;

    if (tool.risk === "draft" && !dryRun) {
      if (!idemKey || !IDEMPOTENCY_RE.test(idemKey)) {
        throw new DoorError(422, "VALIDATION_FAILED", "Idempotency-Key مطلوب لأدوات المسودة", [
          { path: "Idempotency-Key", message: "required, 8-128 chars [A-Za-z0-9_-:.]" },
        ]);
      }
      // نفس المفتاح = نفس المسودة (إعادة الجسر بعد انقطاع ما بتعمل نسخة تانية ولا بتنعد بالسقف).
      const existing = await findDraftByKey(db, token.workspaceId, idemKey);
      if (existing) {
        if (existing.kind !== KIND_BY_TOOL[tool.name]) {
          throw new DoorError(422, "VALIDATION_FAILED", "Idempotency-Key مستخدم لمسودة من نوع تاني", [
            { path: "Idempotency-Key", message: "key already used by another draft kind" },
          ]);
        }
        const data = tool.output.parse(draftOutputFromRow(existing, tz));
        const res: CallOk = {
          status: "draft_created",
          data,
          meta: buildMeta({ links: [{ title_ar: "راجع المسودة", url: draftReviewUrl(existing.id) }] }, tz, now),
          request_id: input.requestId,
        };
        await logCall(db, { workspaceId: token.workspaceId, tokenId: token.id, tool: tool.name, risk, status: "draft_replayed", errorCode: null, requestId: input.requestId, agentRef: input.agentRef, dryRun, latencyMs: Date.now() - started });
        return res;
      }
      const since = resolvePeriod({ period: "today" }, tz, now).start;
      const used = await countDraftsSince(db, token.id, since);
      if (used >= token.dailyDraftCap) {
        throw new DoorError(429, "DRAFT_CAP_REACHED", `سقف المسودات اليومي (${token.dailyDraftCap}) خلص — بيرجع بكرا`);
      }
    }

    let result;
    try {
      result = await tool.run(
        { db, workspaceId: token.workspaceId, token, tz, now, dryRun, idempotencyKey: idemKey },
        parsedInput.data
      );
    } catch (err) {
      if (err instanceof DoorError) throw err;
      if (err instanceof z.ZodError) throw new DoorError(422, "VALIDATION_FAILED", "مدخلات الأداة غلط", zodDetails(err));
      if (err instanceof AppError) {
        const mapped = appErrorToDoor(err);
        if (mapped.httpStatus >= 500) log.error({ err, tool: tool.name, requestId: input.requestId }, "agent_tool_failed");
        throw mapped;
      }
      log.error({ err, tool: tool.name, requestId: input.requestId }, "agent_tool_crashed");
      throw new DoorError(500, "INTERNAL", "خطأ داخلي");
    }

    // المخرج مقابل مخططه حرفيًا: أي حقل زيادة أو نوع غلط = خطأ عندنا، ما بيطلع.
    const out = tool.output.safeParse(result.data);
    if (!out.success) {
      log.error({ tool: tool.name, issues: zodDetails(out.error), requestId: input.requestId }, "agent_output_schema_violation");
      throw new DoorError(500, "INTERNAL", "رد الأداة طلع عن مخططه — انمنع وانسجّل");
    }
    // سور تاني: ولا نمط هاتف أو إيميل أو مفتاح شخصي بأي مخرج.
    const pii = findPii(out.data);
    if (pii.length > 0) {
      log.error({ tool: tool.name, paths: pii.map((f) => `${f.kind}@${f.path}`), requestId: input.requestId }, "agent_output_pii_blocked");
      throw new DoorError(500, "INTERNAL", "رد الأداة فيه نمط بيانات شخصية — انمنع وانسجّل");
    }
    const res: CallOk = { status: result.status, data: out.data, meta: buildMeta(result.meta, tz, now), request_id: input.requestId };
    await logCall(db, { workspaceId: token.workspaceId, tokenId: token.id, tool: tool.name, risk, status: result.status, errorCode: null, requestId: input.requestId, agentRef: input.agentRef, dryRun, latencyMs: Date.now() - started });
    return res;
  } catch (err) {
    const door = err instanceof DoorError ? err : new DoorError(500, "INTERNAL", "خطأ داخلي");
    if (!(err instanceof DoorError)) log.error({ err, requestId: input.requestId }, "agent_door_unhandled");
    await logCall(db, {
      workspaceId: token.workspaceId,
      tokenId: token.id,
      tool: toolName,
      risk,
      status: "error",
      errorCode: door.code,
      requestId: input.requestId,
      agentRef: input.agentRef,
      dryRun,
      latencyMs: Date.now() - started,
    });
    throw door;
  }
}

export interface CallLogView {
  id: string;
  tool: string;
  risk: string;
  status: string;
  errorCode: string | null;
  agentRef: string | null;
  dryRun: boolean;
  latencyMs: number;
  createdAt: string;
}

/** سجل النداءات للشاشة (آخر 200) — مين · أي أداة · النتيجة · الوقت. */
export async function listAgentCalls(db: Db, workspaceId: string, limit = 100): Promise<CallLogView[]> {
  const rows = (await (db as unknown as { agentCallLog: { findMany: (a: unknown) => Promise<unknown> } }).agentCallLog.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  })) as Array<{ id: string; tool: string; risk: string; status: string; errorCode: string | null; agentRef: string | null; dryRun: boolean; latencyMs: number; createdAt: Date | string }>;
  return rows.map((r) => ({
    id: r.id,
    tool: r.tool,
    risk: r.risk,
    status: r.status,
    errorCode: r.errorCode,
    agentRef: r.agentRef,
    dryRun: r.dryRun,
    latencyMs: r.latencyMs,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

/** عدّادات اليوم للشاشة: نداءات ناجحة · مرفوضة · مسودات. */
export async function agentCallStats(db: Db, workspaceId: string, since: Date) {
  const m = (db as unknown as { agentCallLog: { count: (a: unknown) => Promise<number> } }).agentCallLog;
  const [total, errors, drafts] = await Promise.all([
    m.count({ where: { workspaceId, createdAt: { gte: since } } }),
    m.count({ where: { workspaceId, createdAt: { gte: since }, status: "error" } }),
    m.count({ where: { workspaceId, createdAt: { gte: since }, status: "draft_created" } }),
  ]);
  return { total, errors, drafts };
}
