import { analyticsRoute } from "../_shared";
import { getFunnel } from "@/modules/analytics/service";

export const GET = analyticsRoute(getFunnel);
