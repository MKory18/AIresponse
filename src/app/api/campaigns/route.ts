import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { createCampaign } from "@/modules/campaigns/campaign-service";

/** P9 — الحملات: قائمة + إنشاء (مسودة) — صلاحية campaigns.write للإنشاء. */

export const GET = createHandler({ query: z.object({}).passthrough(), permission: "campaigns.read" }, async ({ auth }) => {
  const items = await prisma.campaign.findMany({
    where: { workspaceId: auth!.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true, name: true, description: true, channelType: true, status: true,
      segmentId: true, scheduledAt: true, ratePerMinute: true, approvedAt: true,
      startedAt: true, completedAt: true, cancelReason: true, failReason: true, createdAt: true,
    },
  });
  return ok({ items });
});

export const POST = createHandler({ body: z.unknown(), permission: "campaigns.write" }, async ({ auth, body }) => {
  const result = await createCampaign(prisma, auth!, body);
  return ok({ id: result.campaign.id, versionId: result.version.id }, 201);
});
