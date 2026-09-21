import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listQuerySchema } from "@/modules/conversations/schemas";
import { listCustomers } from "@/modules/customers/service";

export const GET = createHandler(
  { query: listQuerySchema, permission: "customers.read" },
  async ({ auth, query }) => {
    const result = await listCustomers(prisma, {
      workspaceId: auth!.workspaceId,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return ok(result);
  }
);
