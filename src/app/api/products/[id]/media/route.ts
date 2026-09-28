import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { productMediaActionSchema } from "@/modules/products/schemas";
import {
  attachProductMedia,
  detachProductMedia,
  reorderProductMedia,
  setPrimaryProductMedia,
  updateProduct,
} from "@/modules/products/service";
import { z } from "zod";

type Params = { id: string };

/** POST /api/products/[id]/media — attach media / set primary / detach. */
export const POST = createHandler(
  { body: productMediaActionSchema, permission: "products.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const link = await attachProductMedia(prisma, auth!, id, body.mediaAssetId, {
      isPrimary: body.isPrimary,
      sortOrder: body.sortOrder,
    });
    return ok(link, 201);
  }
);

export const PATCH = createHandler(
  { body: productMediaActionSchema, permission: "products.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    await setPrimaryProductMedia(prisma, auth!, id, body.mediaAssetId);
    return ok({ ok: true });
  }
);

export const DELETE = createHandler(
  {
    body: z.object({ mediaAssetId: z.string().cuid() }),
    permission: "products.write",
  },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    await detachProductMedia(prisma, auth!, id, body.mediaAssetId);
    return ok({ ok: true });
  }
);

/** PUT /api/products/[id]/media — persist display order (sortOrder = index). */
export const PUT = createHandler(
  {
    body: z.object({ orderedMediaIds: z.array(z.string().cuid()).min(1).max(100) }),
    permission: "products.write",
  },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    await reorderProductMedia(prisma, auth!, id, body.orderedMediaIds);
    return ok({ ok: true });
  }
);
