import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { revokeIntegrationToken } from "@/modules/integrations/tokens";

/** إيقاف توكن فورًا (بيصير 401 من أول طلب). ما بينحذف الصف — بيضل بالسجل مع تاريخ الإيقاف. */
export const POST = createHandler(
  { permission: "integrations.manage", rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ auth, params, req }) => {
    const { id } = params as { id: string };
    const view = await revokeIntegrationToken(
      prisma as unknown as Db,
      { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined },
      id
    );
    return ok({ view });
  }
);
