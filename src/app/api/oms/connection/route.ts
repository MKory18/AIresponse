import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { upsertOmsConnection } from "@/modules/oms/sync";

const connectionSchema = z.object({
  baseUrl: z.string().url().max(500),
  token: z.string().min(8).max(500),
  isActive: z.boolean().optional(),
});

/** Saves the OMS connection — token encrypted with the channel-secrets cipher. */
export const POST = createHandler(
  { body: connectionSchema, permission: "settings.manage" },
  async ({ auth, body, req }) => {
    const ctx = {
      userId: auth!.userId,
      workspaceId: auth!.workspaceId,
      ip: req.headers.get("x-forwarded-for") ?? undefined,
    };
    const row = await upsertOmsConnection(prisma, ctx, body);
    return ok({ id: row.id, baseUrl: row.baseUrl, isActive: row.isActive });
  }
);
