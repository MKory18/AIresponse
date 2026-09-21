import { analyticsRoute } from "../_shared";
import { getProductAnalytics } from "@/modules/analytics/service";

export const GET = analyticsRoute(getProductAnalytics);
