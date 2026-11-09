import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listParamsSchema, productInputSchema } from "@/modules/products/schemas";
import { createProduct, listProducts, redactProductForActor } from "@/modules/products/service";

export const GET = createHandler(
  { query: listParamsSchema, permission: "products.read" },
  async ({ auth, query }) => {
    const result = await listProducts(prisma, {
      workspaceId: auth!.workspaceId,
      q: query.q,
      category: query.category,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return ok({ ...result, items: result.items.map((p) => redactProductForActor(p, auth!)) });
  }
);

export const POST = createHandler(
  { body: productInputSchema, permission: "products.write" },
  async ({ auth, body }) => {
    const product = await createProduct(prisma, auth!, body);
    return ok(redactProductForActor(product, auth!), 201);
  }
);
