import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { deletePlaygroundSession, getPlaygroundSession } from "@/modules/ai/playground-service";

type Params = { id: string };

/** GET /api/ai/playground/sessions/[id] — session + its internal messages. */
export const GET = createHandler({ permission: "ai.configure" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const result = await getPlaygroundSession(prisma, auth!, id);
  return ok(result);
});

/** DELETE /api/ai/playground/sessions/[id] — delete session + messages. */
export const DELETE = createHandler({ permission: "ai.configure" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const result = await deletePlaygroundSession(prisma, auth!, id);
  return ok(result);
});
