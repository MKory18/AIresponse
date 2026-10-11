import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { PERSONA_LIMITS } from "@/modules/ai/persona-limits";
import { assertLocalPersonaMutable } from "@/modules/ai/persona-control";

const personaSchema = z.object({
  name: z.string().trim().min(2).max(PERSONA_LIMITS.name),
  language: z.string().trim().max(20).default("ar"),
  dialect: z.string().trim().max(50).nullable().optional(),
  tone: z.string().trim().max(50).default("friendly"),
  formality: z.string().trim().max(50).default("informal"),
  responseLength: z.string().trim().max(30).default("short"),
  emojiLevel: z.number().int().min(0).max(5).default(1),
  salesStyle: z.string().trim().max(50).default("helpful"),
  systemInstructions: z
    .string()
    .max(PERSONA_LIMITS.systemInstructions, `تعليمات الشخصية يجب ألا تتجاوز ${PERSONA_LIMITS.systemInstructions} حرفاً`)
    .nullable()
    .optional(),
  prohibitedPhrases: z.array(z.string().trim().max(PERSONA_LIMITS.prohibitedPhrase)).max(PERSONA_LIMITS.prohibitedPhrases).optional(),
  customRules: z.array(z.string().trim().max(PERSONA_LIMITS.customRule)).max(PERSONA_LIMITS.customRules).optional(),
  isActive: z.boolean().optional(),
});

export const GET = createHandler(
  { permission: "personas.read" },
  async ({ auth }) => {
    const personas = await prisma.persona.findMany({
      where: { workspaceId: auth!.workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return ok({ items: personas });
  }
);

export const POST = createHandler(
  { body: personaSchema, permission: "personas.write" },
  async ({ auth, body }) => {
    // Only one active persona at a time per workspace.
    // Activation changes live reply personality — refused while Hermes owns it.
    if (body.isActive !== false) {
      await assertLocalPersonaMutable(auth!.workspaceId);
      await prisma.persona.updateMany({
        where: { workspaceId: auth!.workspaceId, isActive: true },
        data: { isActive: false },
      });
    }
    const persona = await prisma.persona.create({
      data: { ...body, workspaceId: auth!.workspaceId, isActive: body.isActive ?? true },
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "persona.created",
      entityType: "Persona",
      entityId: persona.id,
    });
    return ok(persona, 201);
  }
);

export const PATCH = createHandler(
  { body: personaSchema.partial().extend({ id: z.string().cuid() }), permission: "personas.write" },
  async ({ auth, body }) => {
    const { id, ...data } = body;
    const existing = await prisma.persona.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== auth!.workspaceId) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (data.isActive) {
      // Activating swaps the live reply personality — refused under Hermes.
      await assertLocalPersonaMutable(auth!.workspaceId);
      await prisma.persona.updateMany({
        where: { workspaceId: auth!.workspaceId, isActive: true },
        data: { isActive: false },
      });
    }
    const persona = await prisma.persona.update({ where: { id }, data });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "persona.updated",
      entityType: "Persona",
      entityId: id,
    });
    return ok(persona);
  }
);
