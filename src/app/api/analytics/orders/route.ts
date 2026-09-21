import { analyticsRoute } from "../_shared";
import { getOrderAnalytics } from "@/modules/analytics/service";

export const GET = analyticsRoute(getOrderAnalytics);
