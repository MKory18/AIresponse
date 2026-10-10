import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { PERSONA_LIMITS } from "@/modules/ai/persona-limits";
import { createVersion, listVersions } from "@/modules/ai/persona-versions";

type Params = { id: string };

const draftSchema = z.object({
  name: z.string().trim().min(2).max(PERSONA_LIMITS.name).optional(),
  tone: z.string().trim().max(50).optional(),
  language: z.string().trim().max(20).optional(),
  dialect: z.string().trim().max(50).nullable().optional(),
  formality: z.string().trim().max(50).optional(),
  responseLength: z.string().trim().max(30).optional(),
  emojiLevel: z.number().int().min(0).max(5).optional(),
  salesStyle: z.string().trim().max(50).optional(),
  systemInstructions: z.string().max(PERSONA_LIMITS.systemInstructions).nullable().optional(),
  prohibitedPhrases: z.array(z.string().trim().max(PERSONA_LIMITS.prohibitedPhrase)).max(PERSONA_LIMITS.prohibitedPhrases).optional(),
  customRules: z.array(z.string().trim().max(PERSONA_LIMITS.customRule)).max(PERSONA_LIMITS.customRules).optional(),
});

/** GET list versions (newest first). Permission: personas.read. */
export const GET = createHandler({ permission: "personas.read" }, async ({ auth, params }) => {
  const { id } = params as Params;
  return ok({ items: await listVersions(prisma, auth!.workspaceId, id) });
});

/**
 * POST create a DRAFT snapshot of the CURRENT live instructions (plus
 * optional overrides). Never touches the live row — publishing is explicit.
 * Permission: personas.write.
 */
export const POST = createHandler({ body: draftSchema, permission: "personas.write" }, async ({ auth, body, params }) => {
  const { id } = params as Params;
  return ok(await createVersion(prisma, auth!, id, body), 201);
});
