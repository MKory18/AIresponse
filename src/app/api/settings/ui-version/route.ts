import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { AuthorizationError } from "@/core/errors";
import { getIntegrationSettings, updateIntegrationSettings } from "@/modules/integrations/settings";
import { isOwnerRole } from "@/modules/rbac/owner-guard";

/**
 * نسخة الواجهة للمساحة كلها (2.3ب): تفعيل الواجهة الجديدة للفريق = ضغطة **المالك** (قاعدة المالك: أي تفعيل
 * بالإنتاج بإيده). المعاينة الشخصية بالكوكي \`zr-ui\` ما بتمرّ من هون.
 */
export const GET = createHandler({ permission: "settings.manage" }, async ({ auth }) => {
  const s = await getIntegrationSettings(prisma as never, auth!.workspaceId);
  return ok({ uiVersion: s.uiVersion, canChange: isOwnerRole(auth!.role) });
});

export const PATCH = createHandler(
  { permission: "settings.manage", body: z.object({ uiVersion: z.enum(["v1", "v2"]) }).strict(), rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ auth, body, req }) => {
    if (!isOwnerRole(auth!.role)) throw new AuthorizationError("تغيير نسخة الواجهة للفريق للمالك فقط");
    const next = await updateIntegrationSettings(
      prisma as never,
      { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined },
      { uiVersion: body.uiVersion }
    );
    return ok({ uiVersion: next.uiVersion });
  }
);
