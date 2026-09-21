import { analyticsRoute } from "../_shared";
import { getHandoffAnalytics } from "@/modules/analytics/service";

export const GET = analyticsRoute(getHandoffAnalytics);
