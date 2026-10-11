import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { assertLocalPersonaMutable } from "@/modules/ai/persona-control";

type Params = { id: string };

const assignSchema = z.object({
  /** Persona id to bind to this channel, or null to fall back to workspace default. */
  personaId: z.string().cuid().nullable(),
});

/**
 * P6 — PATCH channel → persona binding (channels.connect).
 * Priority stays: channel assignment → workspace default → builtin.
 * Cross-workspace personas are rejected (404, no leak).
 */
export const PATCH = createHandler(
  { body: assignSchema, permission: "channels.connect" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel || channel.workspaceId !== auth!.workspaceId) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (body.personaId) {
      // Binding a local persona changes reply personality (unassign/null stays allowed).
      await assertLocalPersonaMutable(auth!.workspaceId);
      const persona = await prisma.persona.findFirst({
        where: { id: body.personaId, workspaceId: auth!.workspaceId },
      });
      if (!persona) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const updated = await prisma.channel.update({
      where: { id },
      data: { aiPersonaId: body.personaId },
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "channel.persona_assigned",
      entityType: "Channel",
      entityId: id,
      metadata: { personaId: body.personaId },
    });
    return ok({ id: updated.id, aiPersonaId: updated.aiPersonaId });
  }
);
