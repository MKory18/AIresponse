import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { feedbackUpdateSchema } from "@/modules/products/schemas";
import { getOwnedFeedback, updateFeedback } from "@/modules/feedback/service";

type Params = { id: string };

export const GET = createHandler(
  { permission: "feedback.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const feedback = await getOwnedFeedback(prisma, auth!.workspaceId, id);
    return ok(feedback);
  }
);

export const PATCH = createHandler(
  { body: feedbackUpdateSchema, permission: "feedback.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const updated = await updateFeedback(prisma, auth!, id, body);
    return ok(updated);
  }
);
