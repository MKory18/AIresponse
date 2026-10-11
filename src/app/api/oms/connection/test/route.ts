import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { probeOmsConnection } from "@/modules/oms/connection";

/** فحص حي لاتصال الـ OMS: الصحة ثم وجود باب /api/v1 (بوضع api). */
export const POST = createHandler({ permission: "settings.manage", rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ auth }) => {
  return ok(await probeOmsConnection(prisma, auth!.workspaceId));
});
