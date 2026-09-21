import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getQueueMetrics } from "@/modules/analytics/service";

export const GET = createHandler({ permission: "analytics.read" }, async ({ auth }) => {
  const metrics = await getQueueMetrics(prisma, auth!.workspaceId);
  return ok(metrics);
});
