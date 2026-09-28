import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { createPlaygroundSession, listPlaygroundSessions } from "@/modules/ai/playground-service";

const createSchema = z.object({
  personaId: z.string().cuid().nullish(),
  channelId: z.string().cuid().nullish(),
  productId: z.string().cuid().nullish(),
  useKnowledge: z.boolean().optional(),
  model: z.string().trim().max(120).nullish(),
});

/** GET /api/ai/playground/sessions — list internal test sessions (ai.configure). */
export const GET = createHandler({ permission: "ai.configure" }, async ({ auth }) => {
  const items = await listPlaygroundSessions(prisma, auth!);
  return ok({ items });
});

/** POST /api/ai/playground/sessions — create an isolated internal test session. */
export const POST = createHandler(
  { body: createSchema, permission: "ai.configure", rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ auth, body }) => {
    const session = await createPlaygroundSession(prisma, auth!, body);
    return ok(session, 201);
  }
);
