import { createHandler } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { toCsv } from "@/modules/analytics/csv";
import { exportRows, getReport, reportQuerySchema } from "@/modules/analytics/reports";

/** «تصدير CSV» (3.7): نفس `getReport` اللي بتعرضه الشاشة، فالأرقام متطابقة حتمًا (ومعها المعادلة بعمود). */
export const GET = createHandler({ query: reportQuerySchema, permission: "analytics.read" }, async ({ auth, query }) => {
  const report = await getReport(prisma, auth!.workspaceId, query, auth!.can);
  const rows = exportRows(report);
  const csv = toCsv(rows, ["section", "metric", "value", "currency", "formula"]);
  await recordAudit(prisma as never, {
    workspaceId: auth!.workspaceId,
    userId: auth!.userId,
    action: "analytics.exported",
    entityType: "AnalyticsReport",
    entityId: query.tab,
    metadata: { tab: query.tab, range: query.range, rows: rows.length },
  });
  return new Response(`\uFEFF${csv}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="reports-${query.tab}.csv"`,
    },
  }) as never;
});
