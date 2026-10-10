import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { validateCampaign } from "@/modules/campaigns/campaign-service";

type Params = { id: string };

/** P9 — التحقق قبل النشر: يرفع DRAFT → READY ويحسب بصمة الجمهور. */
export const POST = createHandler({ body: z.object({}).strict(), permission: "campaigns.write" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const result = await validateCampaign(prisma, auth!, id);
  return ok(result);
});
