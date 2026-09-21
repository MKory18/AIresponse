import { analyticsRoute } from "../_shared";
import { getOverview } from "@/modules/analytics/service";

export const GET = analyticsRoute(getOverview);
