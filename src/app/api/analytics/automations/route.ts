import { analyticsRoute } from "../_shared";
import { getAutomationAnalytics } from "@/modules/analytics/service";

export const GET = analyticsRoute(getAutomationAnalytics);
