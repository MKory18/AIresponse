import { NextResponse } from "next/server";
import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { createIntegrationToken, listIntegrationTokens } from "@/modules/integrations/tokens";
import { TOKEN_PRESETS, TOKEN_SCOPES, TOKEN_SYSTEMS } from "@/modules/integrations/systems";

/**
 * «الإعدادات ← توكنات الأنظمة»: التوكنات اللي بتدخل فيها أنظمة المنظومة (الميديا باير · الكليبر) على /api/v1.
 * بتنصنع من هون (مش من النظام التاني) — التوكن بينعرض **مرة وحدة** بالرد على الإنشاء (no-store) وبينحفظ مجزّأ بس.
 * ما بيرجع بأي رد غير الرمز الأولاني (prefix). الصلاحية `integrations.manage`.
 */
const createSchema = z
  .object({
    system: z.enum(TOKEN_SYSTEMS as [string, ...string[]]),
    name: z.string().trim().min(1).max(80).optional(),
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export const GET = createHandler({ permission: "integrations.manage" }, async ({ auth }) => {
  const tokens = await listIntegrationTokens(prisma as unknown as Db, auth!.workspaceId);
  const systems = TOKEN_SYSTEMS.map((key) => ({ key, nameAr: TOKEN_PRESETS[key].nameAr, scopes: [...TOKEN_PRESETS[key].scopes] }));
  return ok({ tokens, systems });
});

export const POST = createHandler(
  { permission: "integrations.manage", body: createSchema, rateLimit: { limit: 10, windowMs: 60_000 } },
  async ({ auth, body, req }) => {
    const created = await createIntegrationToken(
      prisma as unknown as Db,
      { userId: auth!.userId, workspaceId: auth!.workspaceId, ip: req.headers.get("x-forwarded-for") ?? undefined },
      { ...body, system: body.system as keyof typeof TOKEN_PRESETS, scopes: body.scopes as never }
    );
    const res = NextResponse.json({ token: created.token, view: created.view }, { status: 201 });
    res.headers.set("cache-control", "no-store");
    return res;
  }
);
