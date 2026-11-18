import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { ordersCounts } from "@/modules/orders/list-filters";

/** GET /api/orders/counts — عدّاد كل تبويب بالكامل (الكل · تحتاج مراجعة · بانتظار التثبيت · مثبّتة · ملغاة). */
export const GET = createHandler({ permission: "orders.read", rateLimit: { limit: 60, windowMs: 60_000 } }, async ({ auth }) =>
  ok({ counts: await ordersCounts(prisma, auth!.workspaceId) })
);
