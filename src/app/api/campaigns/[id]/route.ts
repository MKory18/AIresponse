import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { updateCampaignDraft, getCampaignRunlog } from "@/modules/campaigns/campaign-service";
import { campaignUpdateSchema } from "@/modules/campaigns/campaign-schemas";

type Params = { id: string };

export const GET = createHandler({ permission: "campaigns.read" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const runlog = await getCampaignRunlog(prisma, auth!.workspaceId, id);
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: {
      id: true, workspaceId: true, name: true, description: true, channelType: true, channelId: true, status: true,
      segmentId: true, scheduledAt: true, timezone: true, ratePerMinute: true, contentVersionId: true,
      approvedBy: true, approvedAt: true, startedAt: true, completedAt: true, cancelledAt: true,
      cancelReason: true, failReason: true, createdAt: true,
    },
  });
  if (!campaign || campaign.workspaceId !== auth!.workspaceId) return ok({ error: "NotFound" }, 404);
  const version = campaign.contentVersionId
    ? await prisma.campaignContentVersion.findUnique({ where: { id: campaign.contentVersionId } })
    : null;
  return ok({ ...campaign, content: version, runlog });
});

export const PATCH = createHandler(
  { body: campaignUpdateSchema, permission: "campaigns.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    await updateCampaignDraft(prisma, auth!, id, body);
    return ok({ ok: true });
  }
);
