import { createSystemHandler, v1Json } from "@/modules/integrations/system-handler";
import { computeCapacity } from "@/modules/integrations/capacity";

export const runtime = "nodejs";

/**
 * P12 — قدرة الرد للميديا باير (عقد IN03 §2) — حرفيًا:
 * {"unanswered","first_response_p50_min","by_channel","at"}
 * توكن الميديا باير بصلاحية capacity.read فقط.
 */
export const GET = createSystemHandler({ scope: "capacity.read" }, async ({ db, workspaceId, requestId }) => {
  return v1Json(await computeCapacity(db, workspaceId), requestId);
});
