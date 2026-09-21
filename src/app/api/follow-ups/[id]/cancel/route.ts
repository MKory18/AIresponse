import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { cancelFollowUp } from "@/modules/automation/followup-service";
import { AppError } from "@/core/errors";

type Params = { id: string };

export const POST = createHandler(
  { permission: "followups.cancel" },
  async ({ auth, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };
    try {
      const updated = await cancelFollowUp(prisma, ctx, id);
      return ok(updated);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Cannot cancel")) {
        throw new AppError(err.message, 422, "INVALID_FOLLOWUP_STATE");
      }
      throw err;
    }
  }
);
