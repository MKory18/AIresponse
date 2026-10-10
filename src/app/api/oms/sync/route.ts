import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { syncProductsFromOms, syncCustomersFromOms } from "@/modules/oms/sync";

const syncSchema = z.object({
  phones: z.array(z.string().max(32)).max(500).optional(),
});

/** Manual/queue-triggered OMS sync: products + customer blacklist. */
export const POST = createHandler(
  { body: syncSchema, permission: "products.write" },
  async ({ auth, body }) => {
    const ctx = { userId: auth!.userId, workspaceId: auth!.workspaceId };
    const products = await syncProductsFromOms(prisma, ctx);
    const customers = body.phones
      ? await syncCustomersFromOms(prisma, ctx, body.phones)
      : { updated: 0, skipped: 0 };
    return ok({ products, customers });
  }
);
