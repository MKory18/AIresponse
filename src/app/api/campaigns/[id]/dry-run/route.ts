import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { dryRunCampaign } from "@/modules/campaigns/campaign-runner";

type Params = { id: string };

/** P9 — DRY-RUN: قراءة فقط — لا إرسال، لا كتابة، لا أحداث إرسال. */
export const POST = createHandler({ body: z.object({}).strict(), permission: "campaigns.read" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const result = await dryRunCampaign(prisma, auth!.workspaceId, id);
  return ok(result);
});
