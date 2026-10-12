import type { Db } from "@/modules/customers/service";

export interface ResolvedPersona {
  id: string | null;
  name: string;
  language: string;
  dialect: string | null;
  tone: string;
  formality: string;
  responseLength: string;
  emojiLevel: number;
  salesStyle: string;
  systemInstructions: string | null;
  prohibitedPhrases: string[];
  customRules: string[];
  /** Published instruction version (P6) — null for the builtin fallback. */
  version: number | null;
  /** Where the persona came from: page assignment or workspace default. */
  source: "channel" | "workspace" | "builtin";
  /** Page display fields, read with the same row (saves gating a 2nd read). */
  channelPage: { displayName: string | null; externalId: string | null } | null;
}

/**
 * Single source of truth for persona resolution.
 *
 * Priority:
 *   1. Channel/Page assignment (Channel.aiPersonaId, workspace-scoped)
 *   2. Workspace default (the active Persona)
 *   3. Built-in fallback (never hardcoded business copy — bare defaults)
 */
export async function resolveChannelPersona(
  db: Db,
  params: { workspaceId: string; channelId?: string | null }
): Promise<ResolvedPersona> {
  // PERF — the channel row is read ONCE here (workspace scope + assignment
  // + display fields together). Gating reuses resolved.channelPage instead
  // of re-reading the same row: identical data, one round-trip saved.
  let channelPage: ResolvedPersona["channelPage"] = null;
  if (params.channelId) {
    const channel = await (db as any).channel.findUnique({
      where: { id: params.channelId },
      select: { workspaceId: true, aiPersonaId: true, displayName: true, externalId: true },
    });
    if (channel) {
      channelPage = { displayName: channel.displayName ?? null, externalId: channel.externalId ?? null };
    }
    if (channel?.workspaceId === params.workspaceId && channel.aiPersonaId) {
      const assigned = await (db as any).persona.findFirst({
        where: { id: channel.aiPersonaId, workspaceId: params.workspaceId },
      });
      if (assigned) return { ...toResolved(assigned), source: "channel" as const, channelPage };
      // Stale assignment (persona deleted) → fall through to default.
    }
  }
  const fallback = await (db as any).persona.findFirst({
    where: { workspaceId: params.workspaceId, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  if (fallback) return { ...toResolved(fallback), source: "workspace" as const, channelPage };
  return {
    id: null,
    name: "المساعد",
    language: "ar",
    dialect: null,
    tone: "friendly",
    formality: "informal",
    responseLength: "short",
    emojiLevel: 1,
    salesStyle: "helpful",
    systemInstructions: null,
    prohibitedPhrases: [],
    customRules: [],
    version: null,
    source: "builtin",
    channelPage,
  };
}

function toResolved(row: Record<string, unknown>): Omit<ResolvedPersona, "source" | "channelPage"> {
  return {
    id: (row.id as string) ?? null,
    name: (row.name as string) ?? "المساعد",
    language: (row.language as string) ?? "ar",
    dialect: (row.dialect as string | null) ?? null,
    tone: (row.tone as string) ?? "friendly",
    formality: (row.formality as string) ?? "informal",
    responseLength: (row.responseLength as string) ?? "short",
    emojiLevel: (row.emojiLevel as number) ?? 1,
    salesStyle: (row.salesStyle as string) ?? "helpful",
    systemInstructions: (row.systemInstructions as string | null) ?? null,
    prohibitedPhrases: (row.prohibitedPhrases as string[]) ?? [],
    customRules: (row.customRules as string[]) ?? [],
    version: typeof row.version === "number" ? (row.version as number) : null,
  };
}
