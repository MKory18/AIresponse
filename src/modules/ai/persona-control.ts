import { prisma } from "@/core/db/prisma";
import { AppError } from "@/core/errors";
import { getEnv } from "@/core/env";
import { isHermesSelected } from "./router";

/**
 * Hermes external-persona control gate (server-side).
 *
 * When the workspace reply persona is Hermes-controlled, local persona
 * mutations that would change live reply personality are refused with
 * 409 HERMES_PERSONA_CONTROLLED — so the Personas UI can never silently
 * alter replies after control moved to Hermes. Drafting (inactive rows),
 * reads, history, and unassigning (null) stay allowed; tables and history
 * are never deleted here.
 */
export async function assertLocalPersonaMutable(workspaceId: string): Promise<void> {
  let provider: string | null = null;
  try {
    const settings = (await prisma.aISettings.findUnique({ where: { workspaceId } })) as {
      provider?: string | null;
    } | null;
    provider = settings?.provider ?? null;
  } catch {
    // A failing settings read must not mask the handler's own error —
    // treat as mutable and let the downstream call surface the cause.
    return;
  }
  let aiProvider: string | undefined;
  try {
    aiProvider = getEnv().AI_PROVIDER;
  } catch {
    aiProvider = process.env.AI_PROVIDER;
  }
  if (isHermesSelected({ provider }, aiProvider)) {
    throw new AppError(
      "شخصية الرد تُدار في Hermes — بدّل المزود عن hermes أولًا لتعديل الشخصيات المحلية",
      409,
      "HERMES_PERSONA_CONTROLLED"
    );
  }
}
