import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { resetCustomerMemory } from "@/modules/customers/memory";

type Params = { id: string };

/**
 * POST /api/customers/[id]/memory/reset — starts the AI from zero for this
 * customer. Keeps orders, audit, identity and compliance records.
 */
export const POST = createHandler(
  { permission: "customers.memory.reset" },
  async ({ auth, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const result = await resetCustomerMemory(prisma, ctx, id);
    return ok(result);
  }
);
