import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { setChannelMarket } from "@/modules/integrations/overview";

const bodySchema = z.object({ channelId: z.string().min(1).max(64), market: z.enum(["SY", "JO"]).nullable() }).strict();

/** P12 — سوق كل قناة (SY · JO) لفلتر market بأدوات Hermes. */
export const PATCH = createHandler({ body: bodySchema, permission: "settings.manage" }, async ({ auth, body }) => {
  return ok(await setChannelMarket(prisma as unknown as Db, { userId: auth!.userId, workspaceId: auth!.workspaceId }, body.channelId, body.market));
});
