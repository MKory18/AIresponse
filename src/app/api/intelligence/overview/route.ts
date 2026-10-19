import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getLabSnapshot } from "@/modules/intelligence/queries";

/**
 * GET /api/intelligence/overview — إحصائيات مختبر التجميع الحقيقية.
 * كل الأرقام من قاعدة البيانات، ومحصورة بمساحة العمل الحالية (عزل تام).
 */
export const GET = createHandler({ permission: "conversations.read" }, async ({ auth }) => {
  const snapshot = await getLabSnapshot(prisma as never, auth!.workspaceId);
  return ok(snapshot);
});
