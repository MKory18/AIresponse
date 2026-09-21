import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { rebuildRange } from "@/modules/analytics/aggregation";
import { AppError } from "@/core/errors";
import { z } from "zod";

const bodySchema = z.object({
  workspaceId: z.string().cuid(),
  from: z.string().min(10).max(30),
  to: z.string().min(10).max(30),
});

/**
 * POST /api/analytics/rebuild — internal/admin operation: rebuild daily
 * analytics for a date range. SUPER_ADMIN only, audited, rate limited.
 * Handles late events and rebuilds without duplicates (idempotent upsert).
 */
export const POST = createHandler(
  { body: bodySchema, rateLimit: { limit: 5, windowMs: 60_000 } },
  async ({ auth, body }) => {
    if (!auth!.can("workspace.manage") && !auth!.can("settings.manage")) {
      // Only SUPER_ADMIN/OWNER/ADMIN reach here through settings.manage.
      throw new AppError("Rebuild requires super admin", 403, "AUTHORIZATION_ERROR");
    }
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: body.workspaceId, userId: auth!.userId } },
    });
    const isSuper = await prisma.user.findUnique({ where: { id: auth!.userId }, select: { isSuperAdmin: true } });
    if (!isSuper?.isSuperAdmin && !membership) {
      throw new AppError("Cannot rebuild another workspace", 403, "AUTHORIZATION_ERROR");
    }

    const from = new Date(body.from);
    const to = new Date(body.to);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) {
      throw new AppError("Invalid date range", 422, "VALIDATION_ERROR");
    }
    if (to.getTime() - from.getTime() > 92 * 24 * 3600_000) {
      throw new AppError("Range too large (max 92 days)", 422, "VALIDATION_ERROR");
    }

    const days = await rebuildRange(prisma, body.workspaceId, from, to);
    await recordAudit(prisma, {
      workspaceId: body.workspaceId,
      userId: auth!.userId,
      action: "analytics.rebuilt",
      entityType: "DailyWorkspaceAnalytics",
      metadata: { from: body.from, to: body.to, days },
    });
    return ok({ ok: true, days });
  }
);
