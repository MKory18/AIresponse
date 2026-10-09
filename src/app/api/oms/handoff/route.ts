import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { handoffOrderToOms } from "@/modules/oms/handoff";

const handoffSchema = z.object({
  orderId: z.string().cuid(),
});

/** Hands a confirmed order to the OMS (idempotent). */
export const POST = createHandler(
  { body: handoffSchema, permission: "orders.write" },
  async ({ auth, body }) => {
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId };
    const result = await handoffOrderToOms(prisma, ctx, body.orderId);
    return ok(result);
  }
);
