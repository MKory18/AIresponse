import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { searchAll } from "@/modules/search/service";

/** GET /api/search?q= — عميل · طلب (بس اللي بيحق للطالب يشوفه). صفحات الموقع بتنبحث بالمتصفح. */
export const GET = createHandler({ rateLimit: { limit: 60, windowMs: 60_000 } }, async ({ auth, req }) => {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return ok(await searchAll(prisma, auth!.workspaceId, q, auth!.can));
});
