import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedDraft } from "@/modules/orders/draft-service";

type Params = { id: string };

export const GET = createHandler(
  { permission: "orders.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const draft = await getOwnedDraft(prisma, auth!.workspaceId, id);
    return ok(draft);
  }
);
