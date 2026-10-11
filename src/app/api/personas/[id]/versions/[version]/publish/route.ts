import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { publishVersion } from "@/modules/ai/persona-versions";
import { assertLocalPersonaMutable } from "@/modules/ai/persona-control";

type Params = { id: string; version: string };

/**
 * POST publish a DRAFT snapshot onto the live persona (bump version).
 * This is the ONLY path that changes production instructions — explicit,
 * audited, and reversible via rollback. Permission: personas.write.
 */
export const POST = createHandler({ permission: "personas.write" }, async ({ auth, params }) => {
  const { id, version } = params as Params;
  const v = Number(version);
  if (!Number.isInteger(v) || v <= 0) {
    const { AppError } = await import("@/core/errors");
    throw new AppError("Invalid version", 422, "VALIDATION_ERROR");
  }
  // Publishing swaps live instructions — refused while Hermes owns replies.
  await assertLocalPersonaMutable(auth!.workspaceId);
  return ok(await publishVersion(prisma, auth!, id, v));
});
