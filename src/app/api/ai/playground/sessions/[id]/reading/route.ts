import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/jobs/service";
import { readPlaygroundSession } from "@/modules/orders/reader/playground-reading";

type Params = { id: string };

/**
 * POST /api/ai/playground/sessions/[id]/reading — «شو قرأ النظام»: القارئ على محادثة التجربة، بلا إنشاء أي طلب ولا
 * حفظ أي شي (مسار قراءة بس، بصلاحية `ai.configure` مثل باقي التجربة). نداء ذكاء بيستهلك رصيد، فحد الطلبات منخفض.
 */
export const POST = createHandler({ permission: "ai.configure", rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ auth, params }) => {
  const { id } = params as Params;
  return ok(await readPlaygroundSession(prisma as unknown as Db, { workspaceId: auth!.workspaceId, sessionId: id }));
});
