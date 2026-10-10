import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";

type Params = { id: string };

/** P9 — سجل المستلمين: حالات وأسباب مغلقة فقط (بلا بيانات اتصال شخصية). */
export const GET = createHandler(
  { query: z.object({ status: z.string().max(20).optional() }).passthrough(), permission: "campaigns.read" },
  async ({ auth, query, params }) => {
    const { id } = params as Params;
    const where: Record<string, unknown> = { campaignId: id, workspaceId: auth!.workspaceId };
    if (query.status) where.status = query.status;
    const items = await prisma.campaignRecipient.findMany({
      where: where as never,
      orderBy: { createdAt: "asc" },
      take: 500,
      select: {
        id: true, customerId: true, status: true, excludeReason: true,
        attempts: true, lastError: true, errorCategory: true, sentAt: true, conversationId: true,
      },
    });
    return ok({ items });
  }
);
