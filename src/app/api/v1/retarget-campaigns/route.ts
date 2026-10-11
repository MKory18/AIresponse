import { createSystemHandler, v1Json } from "@/modules/integrations/system-handler";
import { createRetargetCampaign } from "@/modules/integrations/clipper";
import { AppError } from "@/core/errors";

export const runtime = "nodejs";

/**
 * P12 — حملة إعادة تواصل من الكليبر (عقد الكليبر IN03 §4).
 * Idempotency-Key إلزامي · الشريحة تُحسب هنا من الموافقين فقط · الرد أعداد:
 * {"campaign_id","status","eligible_count"} — 201 أول مرة، 200 للمكرر.
 */
export const POST = createSystemHandler({ scope: "retarget.create" }, async ({ req, db, workspaceId, requestId }) => {
  const key = req.headers.get("idempotency-key") ?? "";
  if (!key) throw new AppError("Idempotency-Key إلزامي", 422, "IDEMPOTENCY_KEY_REQUIRED");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("جسم الطلب ليس JSON", 422, "VALIDATION_FAILED");
  }
  const { created, response } = await createRetargetCampaign(db, { workspaceId, idempotencyKey: key, body });
  return v1Json(response, requestId, created ? 201 : 200);
});
