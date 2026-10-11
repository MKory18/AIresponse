import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { TOKEN_SCOPES, TOKEN_SYSTEMS } from "@/modules/integrations/systems";
import { createIntegrationToken, listIntegrationTokens } from "@/modules/integrations/tokens";

const createSchema = z
  .object({
    system: z.enum(TOKEN_SYSTEMS as [string, ...string[]]),
    name: z.string().min(1).max(80).optional(),
    scopes: z.array(z.enum(TOKEN_SCOPES)).max(5).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

/** P12 — توكنات الأنظمة الداخلة (الميديا باير · الكليبر · جسر Hermes): الحالة بلا النص. */
export const GET = createHandler({ permission: "settings.manage" }, async ({ auth }) => {
  return ok(await listIntegrationTokens(prisma as unknown as Db, auth!.workspaceId));
});

/** إنشاء توكن — النص الكامل بيرجع هون مرة وحدة بس (المخزّن هاش). */
export const POST = createHandler({ body: createSchema, permission: "settings.manage" }, async ({ auth, body }) => {
  const res = await createIntegrationToken(prisma as unknown as Db, { userId: auth!.userId, workspaceId: auth!.workspaceId }, {
    system: body.system as (typeof TOKEN_SYSTEMS)[number],
    name: body.name,
    scopes: body.scopes,
    expiresInDays: body.expiresInDays,
  });
  return ok(res, 201);
});
