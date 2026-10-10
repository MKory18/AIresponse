import { getCampaignAnalytics } from "@/modules/analytics/campaigns-analytics";
import { analyticsRoute } from "../_shared";

/** P10 — تحليلات الحملات: قبول API ≠ تسليم ≠ قراءة ≠ تحويل — الفصل موثق
 *  داخل الوحدة، والطلبات المنسوبة/ROAS تُعاد UNAVAILABLE (لا إسناد موثوق). */
export const GET = analyticsRoute(getCampaignAnalytics as never);
