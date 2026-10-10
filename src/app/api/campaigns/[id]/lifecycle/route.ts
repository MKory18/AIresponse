import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { pauseCampaign, resumeCampaign, cancelCampaign } from "@/modules/campaigns/campaign-service";

type Params = { id: string };

const bodySchema = z.object({ action: z.enum(["pause", "resume", "cancel"]), reason: z.string().max(300).optional() }).strict();

/** P9 — إيقاف مؤقت/استئناف/إلغاء (إيقاف فوري بقراءة الحالة قبل كل إرسال). */
export const POST = createHandler({ body: bodySchema, permission: "campaigns.write" }, async ({ auth, body, params }) => {
  const { id } = params as Params;
  if (body.action === "pause") return ok(await pauseCampaign(prisma, auth!, id));
  if (body.action === "resume") return ok(await resumeCampaign(prisma, auth!, id));
  return ok(await cancelCampaign(prisma, auth!, id, body.reason));
});
