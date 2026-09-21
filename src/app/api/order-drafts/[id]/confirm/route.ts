import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getOwnedDraft } from "@/modules/orders/draft-service";
import { createOrderFromDraft } from "@/modules/orders/order-service";
import { recordAudit } from "@/modules/audit/service";

type Params = { id: string };

/** Human agent confirms the draft → Rules Engine + OrderService create it. */
export const POST = createHandler(
  { permission: "orders.write" },
  async ({ auth, params, req }) => {
    const { id } = params as Params;
    const draft = await getOwnedDraft(prisma, auth!.workspaceId, id);
    if (draft.state === "CANCELLED" || draft.state === "CONVERTED") {
      return Response.json({ error: "DRAFT_CLOSED" }, { status: 422 });
    }
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    const result = await createOrderFromDraft(prisma, ctx, {
      draftId: id,
      source: "HUMAN",
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "order_draft.confirmed_by_agent",
      entityType: "OrderDraft",
      entityId: id,
      metadata: { orderId: result.orderId },
    });
    return ok(result, 201);
  }
);
