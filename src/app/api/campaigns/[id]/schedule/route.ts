import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { scheduleCampaign } from "@/modules/campaigns/campaign-service";
import { campaignScheduleSchema } from "@/modules/campaigns/campaign-schemas";

type Params = { id: string };

/** P9 — جدولة durable: مهمة run_campaign بمعرّف idempotency ثابت. */
export const POST = createHandler({ body: campaignScheduleSchema, permission: "campaigns.write" }, async ({ auth, body, params }) => {
  const { id } = params as Params;
  const result = await scheduleCampaign(prisma, auth!, id, body);
  return ok(result);
});
