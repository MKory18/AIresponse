import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { listDeliveries } from "@/modules/integrations/outbox";

const querySchema = z.object({
  system: z.string().max(20).optional(),
  status: z.enum(["PENDING", "SENDING", "OK", "FAILED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** P12 — سجل الصادر (أحداث ونداءات): لمين · شو · كم محاولة · شو رجع — بلا نص الطلب. */
export const GET = createHandler({ query: querySchema, permission: "settings.manage" }, async ({ auth, query }) => {
  return ok(await listDeliveries(prisma as unknown as Db, auth!.workspaceId, query));
});
