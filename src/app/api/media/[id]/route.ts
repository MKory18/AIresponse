import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedMedia, updateMedia, deleteMedia } from "@/modules/media/service";
import { mediaUpdateSchema } from "@/modules/products/schemas";

type Params = { id: string };

export const GET = createHandler(
  { permission: "media.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const asset = await getOwnedMedia(prisma, auth!.workspaceId, id);
    return ok(asset);
  }
);

export const PATCH = createHandler(
  { body: mediaUpdateSchema, permission: "media.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const updated = await updateMedia(prisma, auth!, id, body);
    return ok(updated);
  }
);

export const DELETE = createHandler(
  { permission: "media.write" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    await deleteMedia(prisma, auth!, id);
    return ok({ ok: true });
  }
);
