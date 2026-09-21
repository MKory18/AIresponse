import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getWorkspaceUsageSummary } from "@/core/analytics/usage-service";

export const GET = createHandler({ permission: "usage.read" }, async ({ auth }) => {
  const summary = await getWorkspaceUsageSummary(prisma, auth!.workspaceId);
  return ok(summary);
});
