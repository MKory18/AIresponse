import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { revokeIntegrationToken } from "@/modules/integrations/tokens";

/** P12 — زر الإيقاف: التوكن بيترفض فورًا بأي نداء جاي. */
export const DELETE = createHandler({ permission: "settings.manage" }, async ({ auth, params }) => {
  return ok(await revokeIntegrationToken(prisma as unknown as Db, { userId: auth!.userId, workspaceId: auth!.workspaceId }, String(params.id ?? "")));
});
