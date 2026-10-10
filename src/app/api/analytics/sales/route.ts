import { z } from "zod";
import { getSalesAnalytics } from "@/modules/sales/metrics";
import { resolveRange } from "@/modules/analytics/service";
import { analyticsRoute, rangeQuerySchema } from "../_shared";

/** P10 — مؤشرات البيع الإضافي/التكميلي/الخصومات (أحداث P8) — أرقام من SalesEvent فقط.
 *  المقامات: offerAcceptRate = OFFER_ACCEPTED / OFFER_SHOWN (null عند غياب العروض). */
export const GET = analyticsRoute(async (db, workspaceId, query: z.infer<typeof rangeQuerySchema>) => {
  const { start, end } = resolveRange(query);
  return getSalesAnalytics(db as never, workspaceId, { from: start, to: new Date(end.getTime() - 1) });
});
