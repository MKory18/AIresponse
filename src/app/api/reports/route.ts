import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getReport, reportQuerySchema } from "@/modules/analytics/reports";

/**
 * `GET /api/reports?tab=sales|conversations|agent|team&range=…&compare=1` (3.7): أرقام التبويب من كتالوج المؤشرات
 * (`kpi-catalog.ts`) — نفس المصدر للشاشة والتصدير. «الفريق» بصلاحية `analytics.agents` و«الكلفة» بـ`usage.read`
 * (بيتحققوا جوّا `getReport`: الرقم بيرجع «غير متاح» مع السبب مش بيختفي).
 */
export const GET = createHandler({ query: reportQuerySchema, permission: "analytics.read" }, async ({ auth, query }) => {
  const data = await getReport(prisma, auth!.workspaceId, query, auth!.can);
  return ok(data);
});
