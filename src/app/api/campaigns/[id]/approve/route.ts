import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { approveCampaign } from "@/modules/campaigns/campaign-service";

type Params = { id: string };

/** P9 — اعتماد المحتوى (لقطة): صلاحية campaigns.approve خادميًا. */
export const POST = createHandler({ body: z.object({}).strict(), permission: "campaigns.approve" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const result = await approveCampaign(prisma, auth!, id);
  return ok(result);
});
