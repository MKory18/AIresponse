import { z } from "zod";
import { createHandler } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { AppError } from "@/core/errors";
import { resolveRange } from "@/modules/analytics/service";
import {
  getConversationAnalytics,
  getOrderAnalytics,
  getProductAnalytics,
  getAIAnalytics,
  type RangeQuery,
} from "@/modules/analytics/service";
import { getSalesAnalytics } from "@/modules/sales/metrics";
import { getAgentAnalytics } from "@/modules/analytics/agents";
import { getCampaignAnalytics } from "@/modules/analytics/campaigns-analytics";
import { toCsv } from "@/modules/analytics/csv";

/**
 * P10 — تصدير CSV للتقارير: نفس عزل المؤسسة ونفس دوال الحساب المستخدمة في
 * الواجهة (الأرقام متطابقة حتمًا)، بصلاحيات الخادم لكل نوع، وسقوف حجم، وحارس
 * حقن صيغ CSV، وتدقيق للتصدير.
 *
 * الأنواع المتاحة: conversations | orders | products | ai | sales | agents |
 * campaigns. نوع agents يتطلب analytics.agents (المدير فما فوق).
 */

const EXPORT_ROW_LIMIT = 10_000;

const exportQuerySchema = z.object({
  type: z.enum(["conversations", "orders", "products", "ai", "sales", "agents", "campaigns"]),
  range: z.enum(["today", "yesterday", "last_7_days", "last_30_days", "custom"]).optional(),
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
  timezone: z.string().max(60).optional(),
});

type ExportQuery = z.infer<typeof exportQuerySchema>;

async function buildRows(db: typeof prisma, workspaceId: string, query: ExportQuery): Promise<Array<Record<string, unknown>>> {
  const q: RangeQuery = query;
  const { start, end } = resolveRange(q);
  const salesRange = { from: start, to: new Date(end.getTime() - 1) };

  switch (query.type) {
    case "conversations": {
      const r = await getConversationAnalytics(db as never, workspaceId, q);
      return [
        { metric: "newConversations", value: r.newConversations },
        { metric: "inboundMessages", value: r.inboundMessages },
        { metric: "outboundMessages", value: r.outboundMessages },
        { metric: "firstResponse.avgMinutes", value: r.firstResponse.avgMinutes },
        { metric: "firstResponse.medianMinutes", value: r.firstResponse.medianMinutes },
        { metric: "firstResponse.count", value: r.firstResponse.count },
        { metric: "resolution.avgMinutes", value: r.resolution.avgMinutes },
        { metric: "resolution.medianMinutes", value: r.resolution.medianMinutes },
        { metric: "resolution.count", value: r.resolution.count },
      ];
    }
    case "orders": {
      const r = await getOrderAnalytics(db as never, workspaceId, q);
      const rows: Array<Record<string, unknown>> = [
        { metric: "created", value: r.created },
        { metric: "confirmed", value: r.confirmed },
        { metric: "cancelled", value: r.cancelled },
        { metric: "delivered", value: r.delivered },
        { metric: "returned", value: r.returned },
        { metric: "failed", value: r.failed },
        { metric: "gmv.createdGmv", value: r.gmv.createdGmv },
        { metric: "gmv.confirmedGmv", value: r.gmv.confirmedGmv },
        { metric: "gmv.deliveredGmv", value: r.gmv.deliveredGmv },
        { metric: "gmv.discounts", value: r.gmv.discounts },
        { metric: "gmv.deliveryFees", value: r.gmv.deliveryFees },
        { metric: "avgOrderValue.confirmed", value: r.confirmed > 0 ? r.gmv.confirmedGmv / r.confirmed : null },
      ];
      return rows.concat(r.byProvince.map((p) => ({ metric: `byProvince.${p.province}`, value: p.count })));
    }
    case "products": {
      const r = await getProductAnalytics(db as never, workspaceId, q);
      return r.map((p) => ({
        productId: p.productId,
        productName: p.productName,
        units: p.units,
        confirmedOrders: p.confirmedOrders,
        deliveredOrders: p.deliveredOrders,
        confirmedRevenue: p.confirmedRevenue,
        deliveredRevenue: p.deliveredRevenue,
      }));
    }
    case "ai": {
      const r = await getAIAnalytics(db as never, workspaceId, q);
      const rows: Array<Record<string, unknown>> = [
        { metric: "calls", value: r.calls },
        { metric: "successful", value: r.successful },
        { metric: "failed", value: r.failed },
        { metric: "inputTokens", value: r.inputTokens },
        { metric: "outputTokens", value: r.outputTokens },
        // null = لا تسعير معروف (لا صفر مزور) — يُصدَّر فارغًا
        { metric: "estimatedCostUsd", value: r.estimatedCost },
        { metric: "avgLatencyMs", value: r.avgLatencyMs },
      ];
      return rows.concat(
        r.byTask.map((t) => ({ metric: `byTask.${t.key}`, value: t.calls })),
        r.byModel.map((m) => ({ metric: `byModel.${m.key}`, value: m.calls }))
      );
    }
    case "sales": {
      const r = await getSalesAnalytics(db as never, workspaceId, salesRange);
      return [
        { metric: "offersQualified", value: r.offersQualified },
        { metric: "offersShown", value: r.offersShown },
        { metric: "offerAcceptRate", value: r.offerAcceptRate },
        { metric: "crossSellShown", value: r.crossSellShown },
        { metric: "crossSellAdded", value: r.crossSellAdded },
        { metric: "coachUsage", value: r.coachUsage },
        { metric: "discountRequests", value: r.discountRequests },
        { metric: "discountApproved", value: r.discountApproved },
        { metric: "discountRejected", value: r.discountRejected },
      ];
    }
    case "agents": {
      const r = await getAgentAnalytics(db as never, workspaceId, q);
      return r.agents.map((a) => ({
        agentId: a.agentId,
        conversationsAssigned: a.conversationsAssigned,
        repliesSent: a.repliesSent,
        firstResponseMedianMinutes: a.firstResponseMedianMinutes,
        handoffsClaimed: a.handoffsClaimed,
        handoffsResolved: a.handoffsResolved,
        ordersLinked: a.ordersLinked,
        ordersLinkedConfirmed: a.ordersLinkedConfirmed,
        ordersLinkedConfirmedValue: a.ordersLinkedConfirmedValue,
        discountApproved: a.discountApproved,
        discountRejected: a.discountRejected,
      }));
    }
    case "campaigns": {
      const r = await getCampaignAnalytics(db as never, workspaceId, q);
      const rows: Array<Record<string, unknown>> = [
        { metric: "campaigns.createdInRange", value: r.campaigns.createdInRange },
        ...Object.entries(r.campaigns.statusDistribution).map(([k, v]) => ({ metric: `campaigns.status.${k}`, value: v })),
        { metric: "audience.uniqueRecipients", value: r.audience.uniqueRecipients },
        { metric: "audience.recipientRows", value: r.audience.recipientRows },
        ...Object.entries(r.audience.byStatus).map(([k, v]) => ({ metric: `audience.status.${k}`, value: v })),
        ...Object.entries(r.audience.byExcludeReason).map(([k, v]) => ({ metric: `audience.excluded.${k}`, value: v })),
        { metric: "sending.apiAccepted", value: r.sending.apiAccepted },
        { metric: "sending.deliveryConfirmed", value: r.sending.deliveryConfirmed },
        { metric: "sending.readConfirmed", value: r.sending.readConfirmed },
        { metric: "sending.deliveryVerification", value: r.sending.deliveryVerification },
        { metric: "attribution.attributedOrders", value: "" },
        { metric: "attribution.status", value: r.attribution.status },
      ];
      return rows;
    }
    default:
      throw new AppError("نوع تصدير غير معروف", 422, "INVALID_EXPORT_TYPE");
  }
}

export const GET = createHandler({ query: exportQuerySchema, permission: "analytics.read" }, async ({ auth, query }) => {
  const workspaceId = auth!.workspaceId;
  if (query.type === "agents" && !auth!.can("analytics.agents")) {
    throw new AppError("تصدير أداء الموظفين يتطلب صلاحية analytics.agents", 403, "FORBIDDEN");
  }
  const rows = await buildRows(prisma, workspaceId, query);
  if (rows.length > EXPORT_ROW_LIMIT) {
    throw new AppError(`حجم التصدير يتجاوز الحد (${EXPORT_ROW_LIMIT} صفًا)`, 422, "EXPORT_TOO_LARGE");
  }
  const columns = query.type === "agents" ? undefined : ["metric", "value"];
  const csv = toCsv(rows, columns);
  await recordAudit(prisma as never, {
    workspaceId,
    userId: auth!.userId,
    action: "analytics.exported",
    entityType: "AnalyticsReport",
    entityId: query.type,
    metadata: { type: query.type, rows: rows.length },
  });
  return new Response(`\uFEFF${csv}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="analytics-${query.type}.csv"`,
    },
  }) as never;
});
