import { analyticsRoute } from "../_shared";
import { getConversationAnalytics } from "@/modules/analytics/service";

export const GET = analyticsRoute(getConversationAnalytics);
