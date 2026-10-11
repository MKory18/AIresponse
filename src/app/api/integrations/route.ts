import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { integrationsOverview } from "@/modules/integrations/overview";

export const dynamic = "force-dynamic";

/** P12 — صفحة «الربط مع الأنظمة»: كل الأنظمة والاتصالات والتوكنات (بلا أي سر). */
export const GET = createHandler({ permission: "settings.manage" }, async ({ auth }) => {
  return ok(await integrationsOverview(prisma as unknown as Db, auth!.workspaceId));
});
