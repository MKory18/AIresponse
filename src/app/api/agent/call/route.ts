import { callAgentTool, DoorError, sanitizeAgentRef } from "@/modules/agent-door/door";
import { doorJson, withAgentDoor } from "@/modules/agent-door/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

/**
 * P12 — POST /api/agent/call (agent-door/v1 §4): نداء أداة وحدة.
 * الرؤوس: Authorization · X-Request-Id (بيرجع) · X-Agent-Ref · Idempotency-Key
 * (إلزامي لأدوات المسودة بلا dry_run).
 */
export const POST = withAgentDoor(async ({ req, db, token, requestId }) => {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new DoorError(422, "VALIDATION_FAILED", "النداء أكبر من 32KB");
  }
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new DoorError(422, "VALIDATION_FAILED", "النداء مش JSON صالح");
  }
  const res = await callAgentTool(db, {
    token,
    body,
    requestId,
    agentRef: sanitizeAgentRef(req.headers.get("x-agent-ref")),
    idempotencyKey: req.headers.get("idempotency-key"),
  });
  return doorJson(res, requestId);
});
