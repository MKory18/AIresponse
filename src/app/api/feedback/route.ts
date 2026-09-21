import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { feedbackInputSchema, listParamsSchema } from "@/modules/products/schemas";
import { createFeedback, listFeedback } from "@/modules/feedback/service";

export const GET = createHandler(
  { query: listParamsSchema, permission: "feedback.read" },
  async ({ auth, query }) => {
    const result = await listFeedback(prisma, {
      workspaceId: auth!.workspaceId,
      productId: query.productId,
      sentiment: query.sentiment,
      approved: query.approved,
      archived: query.archived,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return ok(result);
  }
);

export const POST = createHandler(
  { body: feedbackInputSchema, permission: "feedback.write" },
  async ({ auth, body }) => {
    const feedback = await createFeedback(prisma, auth!, body);
    return ok(feedback, 201);
  }
);
