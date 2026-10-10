import { NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { PERSONA_LIMITS } from "./persona-limits";

/**
 * P6 — Persona/prompt versioning.
 *
 * - Every persona starts at version 1 (the live row IS the published state).
 * - createVersion snapshots the CURRENT live row as an immutable DRAFT row.
 * - publishVersion copies a snapshot onto the live row (bump Persona.version)
 *   and marks the snapshot PUBLISHED. Production instructions change ONLY here.
 * - rollbackVersion restores a snapshot as a NEW version (history append-only).
 * - Drafts can be tested in the isolated playground via personaVersionId
 *   without touching production rows.
 */

export interface PersonaSnapshot {
  name: string;
  tone: string;
  language: string;
  dialect: string | null;
  formality: string;
  emojiLevel: number;
  responseLength: string;
  salesStyle: string;
  systemInstructions: string | null;
  prohibitedPhrases: string[];
  customRules: string[];
}

export function snapshotOf(row: Record<string, unknown>): PersonaSnapshot {
  return {
    name: String(row.name ?? "المساعد"),
    tone: String(row.tone ?? "friendly"),
    language: String(row.language ?? "ar"),
    dialect: (row.dialect as string | null) ?? null,
    formality: String(row.formality ?? "informal"),
    emojiLevel: Number(row.emojiLevel ?? 1),
    responseLength: String(row.responseLength ?? "short"),
    salesStyle: String(row.salesStyle ?? "helpful"),
    systemInstructions: (row.systemInstructions as string | null) ?? null,
    prohibitedPhrases: ((row.prohibitedPhrases as string[]) ?? []).slice(0, PERSONA_LIMITS.prohibitedPhrases),
    customRules: ((row.customRules as string[]) ?? []).slice(0, PERSONA_LIMITS.customRules),
  };
}

async function ownedPersona(db: Db, workspaceId: string, personaId: string) {
  const row = await (db as any).persona.findUnique({ where: { id: personaId } });
  if (!row || row.workspaceId !== workspaceId) throw new NotFoundError("Persona");
  return row;
}

export async function listVersions(db: Db, workspaceId: string, personaId: string) {
  await ownedPersona(db, workspaceId, personaId);
  return (db as any).personaVersion.findMany({
    where: { workspaceId, personaId },
    orderBy: [{ version: "desc" }],
    take: 50,
  });
}

export async function createVersion(
  db: Db,
  ctx: ActorContext,
  personaId: string,
  overrides?: Partial<PersonaSnapshot>
) {
  const live = await ownedPersona(db, ctx.workspaceId, personaId);
  const snap: PersonaSnapshot = { ...snapshotOf(live), ...(overrides ?? {}) };
  if (snap.systemInstructions && snap.systemInstructions.length > PERSONA_LIMITS.systemInstructions) {
    const { AppError } = await import("@/core/errors");
    throw new AppError(`تعليمات الشخصية يجب ألا تتجاوز ${PERSONA_LIMITS.systemInstructions} حرفاً`, 422, "VALIDATION_ERROR");
  }
  const existing = await (db as any).personaVersion.findMany({
    where: { personaId },
    orderBy: [{ version: "desc" }],
    take: 1,
  });
  // Next free number: after both the live row and every snapshot.
  const free = Math.max((existing[0]?.version as number) ?? 0, ((live.version as number) ?? 1)) + 1;
  const row = await (db as any).personaVersion.create({
    data: {
      workspaceId: ctx.workspaceId,
      personaId,
      version: free,
      ...snap,
      status: "DRAFT",
      createdBy: ctx.userId,
    },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "persona_version.created",
    entityType: "PersonaVersion",
    entityId: row.id,
    metadata: { personaId, version: free },
  });
  return row;
}

export async function publishVersion(db: Db, ctx: ActorContext, personaId: string, version: number) {
  const live = await ownedPersona(db, ctx.workspaceId, personaId);
  const snap = await (db as any).personaVersion.findUnique({
    where: { personaId_version: { personaId, version } },
  });
  if (!snap || snap.workspaceId !== ctx.workspaceId) throw new NotFoundError("Persona version");
  const data = snapshotOf(snap);
  const updated = await (db as any).persona.update({
    where: { id: personaId },
    data: { ...data, version: { increment: 1 } },
  });
  await (db as any).personaVersion.update({
    where: { id: snap.id },
    data: { status: "PUBLISHED" },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "persona_version.published",
    entityType: "Persona",
    entityId: personaId,
    metadata: { version, liveVersion: updated.version, previousUpdatedAt: live.updatedAt ?? null },
  });
  return updated;
}

export async function rollbackVersion(db: Db, ctx: ActorContext, personaId: string, version: number) {
  const snap = await (db as any).personaVersion.findUnique({
    where: { personaId_version: { personaId, version } },
  });
  if (!snap || snap.workspaceId !== ctx.workspaceId) throw new NotFoundError("Persona version");
  await ownedPersona(db, ctx.workspaceId, personaId);
  // Rollback = publish the old snapshot as a NEW live state (audit shows it).
  const data = snapshotOf(snap);
  const updated = await (db as any).persona.update({
    where: { id: personaId },
    data: { ...data, version: { increment: 1 } },
  });
  const existing = await (db as any).personaVersion.findMany({
    where: { personaId },
    orderBy: [{ version: "desc" }],
    take: 1,
  });
  const marker = await (db as any).personaVersion.create({
    data: {
      workspaceId: ctx.workspaceId,
      personaId,
      version: ((existing[0]?.version as number) ?? version) + 1,
      ...data,
      status: "ROLLED_BACK",
      createdBy: ctx.userId,
    },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "persona_version.rolled_back",
    entityType: "Persona",
    entityId: personaId,
    metadata: { fromVersion: version, markerVersion: marker.version, liveVersion: updated.version },
  });
  return updated;
}
