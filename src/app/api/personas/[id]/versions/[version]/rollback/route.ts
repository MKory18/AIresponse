import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { rollbackVersion } from "@/modules/ai/persona-versions";
import { assertLocalPersonaMutable } from "@/modules/ai/persona-control";

type Params = { id: string; version: string };

/**
 * POST rollback: restore an older snapshot as the NEW live state
 * (append-only history — the past is never rewritten). Audited.
 * Permission: personas.write.
 */
export const POST = createHandler({ permission: "personas.write" }, async ({ auth, params }) => {
  const { id, version } = params as Params;
  const v = Number(version);
  if (!Number.isInteger(v) || v <= 0) {
    const { AppError } = await import("@/core/errors");
    throw new AppError("Invalid version", 422, "VALIDATION_ERROR");
  }
  // Rollback restores live instructions — refused while Hermes owns replies.
  await assertLocalPersonaMutable(auth!.workspaceId);
  return ok(await rollbackVersion(prisma, auth!, id, v));
});
