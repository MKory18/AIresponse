import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { listMedia } from "@/modules/media/service";
import { listParamsSchema } from "@/modules/products/schemas";
import type { MediaCategory, MediaType } from "@prisma/client";

export const GET = createHandler(
  { query: listParamsSchema, permission: "media.read" },
  async ({ auth, query }) => {
    const result = await listMedia(prisma, {
      workspaceId: auth!.workspaceId,
      category: query.category as MediaCategory | undefined,
      type: query.type as MediaType | undefined,
      productId: query.productId,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return ok(result);
  }
);
