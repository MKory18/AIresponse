import { createSystemHandler, v1Json } from "@/modules/integrations/system-handler";
import { getRetargetCampaign } from "@/modules/integrations/clipper";

export const runtime = "nodejs";

/** P12 — حالة حملة الكليبر وأعدادها (لا أشخاص). */
export const GET = createSystemHandler({ scope: "retarget.read" }, async ({ db, workspaceId, requestId, params }) => {
  const id = typeof params.id === "string" ? params.id : "";
  return v1Json(await getRetargetCampaign(db, workspaceId, id), requestId);
});
