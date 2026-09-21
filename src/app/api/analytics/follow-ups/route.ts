import { analyticsRoute } from "../_shared";
import { getFollowUpAnalytics } from "@/modules/analytics/service";

export const GET = analyticsRoute(getFollowUpAnalytics);
