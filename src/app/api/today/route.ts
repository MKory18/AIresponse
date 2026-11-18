import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getToday } from "@/modules/today/service";
import { parseRange } from "@/modules/today/range";

/** GET /api/today?range=today|yesterday|7d|30d — أرقام «اليوم» الأربعة (+ قاعدة احتساب كل رقم) و«بتتثبّت هلأ» و«آخر الطلبات». */
export const GET = createHandler({ permission: "analytics.read", rateLimit: { limit: 60, windowMs: 60_000 } }, async ({ auth, req }) => {
  const range = parseRange(new URL(req.url).searchParams.get("range"));
  return ok(await getToday(prisma, auth!.workspaceId, range));
});
