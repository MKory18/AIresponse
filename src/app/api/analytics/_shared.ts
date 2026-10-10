import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Permission } from "@/modules/rbac/permissions";
import {
  getConversationAnalytics,
  getOrderAnalytics,
  getProductAnalytics,
  getAIAnalytics,
  getAutomationAnalytics,
  getFollowUpAnalytics,
  getHandoffAnalytics,
  getFunnel,
  getSLA,
  resolveRange,
} from "@/modules/analytics/service";

export const rangeQuerySchema = z.object({
  range: z.enum(["today", "yesterday", "last_7_days", "last_30_days", "custom"]).optional(),
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
  timezone: z.string().max(60).optional(),
});

/** Shared factory: validates the range server-side, scopes to the workspace. */
export function analyticsRoute(
  fn: (db: typeof prisma, workspaceId: string, q: z.infer<typeof rangeQuerySchema>) => Promise<unknown>,
  permission: Permission = "analytics.read"
) {
  return createHandler({ query: rangeQuerySchema, permission }, async ({ auth, query }) => {
    resolveRange(query);
    const data = await fn(prisma, auth!.workspaceId, query);
    return ok(data);
  });
}
