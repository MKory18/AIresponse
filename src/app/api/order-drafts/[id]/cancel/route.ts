import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { cancelDraft } from "@/modules/orders/draft-service";

type Params = { id: string };

export const POST = createHandler(
  { permission: "orders.write" },
  async ({ auth, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const draft = await cancelDraft(prisma, ctx, id);
    return ok(draft);
  }
);
