import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { agentCallStats, listAgentCalls } from "@/modules/agent-door/door";
import { resolvePeriod } from "@/modules/agent-door/period";

/** P12 — سجل نداءات باب الوكلاء + عدّادات اليوم (بلا مدخلات). */
export const GET = createHandler({ permission: "settings.manage" }, async ({ auth }) => {
  const db = prisma as unknown as Db;
  const ws = await prisma.workspace.findUnique({ where: { id: auth!.workspaceId }, select: { timezone: true } });
  const since = resolvePeriod({ period: "today" }, ws?.timezone || "UTC").start;
  const [calls, today] = await Promise.all([listAgentCalls(db, auth!.workspaceId, 100), agentCallStats(db, auth!.workspaceId, since)]);
  return ok({ calls, today });
});
