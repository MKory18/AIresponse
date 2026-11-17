import { createSystemHandler, v1Json } from "@/modules/integrations/system-handler";
import { computeAdSignals } from "@/modules/integrations/ad-signals";

export const runtime = "nodejs";

/**
 * R2 — إشارات الإعلانات للميديا باير (عقد replies-mediabuyer.v1): لكل إعلان ولكل يوم أعداد بس
 * (محادثات · أول رد · بلا رد · تحويلات بالسبب · مسودات ومثبّتة)، والخلية الأقل من 5 محادثات محذوفة.
 * توكن الميديا باير بصلاحية ads.read. قراءة بس، ولا بيانات عميل بأي حقل.
 */
export const GET = createSystemHandler({ scope: "ads.read" }, async ({ req, db, workspaceId, requestId }) => {
  const p = new URL(req.url).searchParams;
  const page = await computeAdSignals(db, workspaceId, {
    since: p.get("since"),
    until: p.get("until"),
    cursor: p.get("cursor"),
    limit: p.get("limit"),
  });
  return v1Json(page, requestId);
});
