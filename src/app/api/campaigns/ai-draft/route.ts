import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { suggestCampaignDraft } from "@/modules/campaigns/ai-draft";

/** P9 — اقتراح نص حملة (مساعدة فقط): بلا بيانات عملاء، ومراجعة بشرية إجبارية. */
export const POST = createHandler(
  {
    body: z
      .object({
        channelType: z.enum(["WHATSAPP", "TELEGRAM"]),
        productName: z.string().max(200).optional(),
        tone: z.string().max(100).optional(),
        language: z.string().max(30).optional(),
      })
      .strict(),
    permission: "campaigns.write",
    rateLimit: { limit: 10, windowMs: 60_000 },
  },
  async ({ auth, body }) => {
    const result = await suggestCampaignDraft(prisma, {
      workspaceId: auth!.workspaceId,
      channelType: body.channelType,
      productName: body.productName ?? null,
      tone: body.tone ?? null,
      language: body.language ?? null,
    });
    return ok(result);
  }
);
