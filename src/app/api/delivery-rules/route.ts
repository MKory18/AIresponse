import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { ALL_PROVINCES, deleteRule, listRules, ruleInputSchema, saveRules } from "@/modules/delivery-rules/service";
import { z } from "zod";

/**
 * مناطق التوصيل (3.4): القراءة `products.read`، والكتابة `products.write`. محافظات السوق من قائمة وحدة.
 * ⚠️ أول منطقة بتنضاف بتخلّي باقي المحافظات «غير متاحة» — الرد بيرجّع `partial` و`missing` علشان الواجهة تحذّر.
 */
export const GET = createHandler({ permission: "products.read" }, async ({ auth }) => ok({ ...(await listRules(prisma, auth!.workspaceId)), provinces: ALL_PROVINCES }));

export const PUT = createHandler(
  { permission: "products.write", body: ruleInputSchema, rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ auth, body }) => {
    const saved = await saveRules(prisma, { userId: auth!.userId, workspaceId: auth!.workspaceId }, body);
    return ok({ saved, ...(await listRules(prisma, auth!.workspaceId)) });
  }
);

export const DELETE = createHandler(
  { permission: "products.write", query: z.object({ id: z.string().cuid() }), rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ auth, query }) => {
    await deleteRule(prisma, { userId: auth!.userId, workspaceId: auth!.workspaceId }, query.id);
    return ok({ ...(await listRules(prisma, auth!.workspaceId)) });
  }
);
