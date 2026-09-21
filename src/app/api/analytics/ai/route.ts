import { analyticsRoute } from "../_shared";
import { getAIAnalytics } from "@/modules/analytics/service";

export const GET = analyticsRoute(getAIAnalytics);
