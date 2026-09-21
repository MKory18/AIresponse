import { analyticsRoute } from "../_shared";
import { getSLA } from "@/modules/analytics/service";
import { prisma } from "@/core/db/prisma";

// SLA targets come from workspace settings (configurable, never hardcoded
// business values). Defaults only apply while the workspace hasn't set them.
const DEFAULT_FIRST_RESPONSE_MINUTES = 30;
const DEFAULT_HANDOFF_RESOLUTION_MINUTES = 240;

export const GET = analyticsRoute(async (db, workspaceId, q) => {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { slaFirstResponseMinutes: true, slaHandoffResolutionMinutes: true },
  });
  return getSLA(db, workspaceId, q, {
    slaFirstResponseMinutes: workspace?.slaFirstResponseMinutes ?? DEFAULT_FIRST_RESPONSE_MINUTES,
    slaHandoffResolutionMinutes: workspace?.slaHandoffResolutionMinutes ?? DEFAULT_HANDOFF_RESOLUTION_MINUTES,
  });
});
