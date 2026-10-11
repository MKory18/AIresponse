import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { retryDelivery } from "@/modules/integrations/outbox";

/** P12 — إعادة محاولة يدوية لرسالة ربط فشلت (بعد تصليح الإعداد). */
export const POST = createHandler({ permission: "settings.manage" }, async ({ auth, params }) => {
  await retryDelivery(prisma as unknown as Db, { userId: auth!.userId, workspaceId: auth!.workspaceId }, String(params.id ?? ""));
  return ok({ ok: true });
});
