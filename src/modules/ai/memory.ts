import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";

const log = childLogger("memory");

export type MemoryType = "FACT" | "PREFERENCE" | "ORDER" | "CONVERSATION_SUMMARY" | "IMPORTANT_NOTE";

export interface MemoryCandidate {
  type: "FACT" | "PREFERENCE" | "NOTE";
  content: string;
  confidence?: number;
}

/**
 * Persists memory candidates. Guardrails:
 * - Not every message becomes memory (caller passes curated candidates only).
 * - Deduped per (customer, type, normalized key): re-stating an update
 *   overwrites the same fact instead of accumulating rows.
 */
export async function saveMemories(
  db: Db,
  params: {
    workspaceId: string;
    customerId: string;
    source: string;
    memories: MemoryCandidate[];
  }
): Promise<number> {
  let saved = 0;
  for (const m of params.memories.slice(0, 5)) {
    const content = m.content.trim();
    if (content.length < 5) continue;
    // Generic greetings or transient chat never become memory.
    if (/^(مرحبا|هلا|أهلا|شكرا|شكرًا|ok|تمام)[!.؟\s]*$/i.test(content)) continue;

    const key = normalizeKey(content);
    const type = toMemoryType(m.type);
    const existing = await db.customerMemory.findFirst({
      where: { workspaceId: params.workspaceId, customerId: params.customerId, type, key },
      select: { id: true },
    });
    if (existing) {
      await db.customerMemory.update({
        where: { id: existing.id },
        data: { value: content, confidence: m.confidence ?? 0.9, updatedAt: new Date() },
      });
    } else {
      await db.customerMemory.create({
        data: {
          workspaceId: params.workspaceId,
          customerId: params.customerId,
          type,
          key,
          value: content,
          source: params.source,
          confidence: m.confidence ?? 0.9,
        },
      });
    }
    saved += 1;
  }
  if (saved) log.info({ customerId: params.customerId, saved }, "memories_saved");
  return saved;
}

export async function loadMemory(
  db: Db,
  workspaceId: string,
  customerId: string,
  limit = 10,
  since?: Date | null
) {
  const rows = await db.customerMemory.findMany({
    where: {
      workspaceId,
      customerId,
      type: { not: "CONVERSATION_SUMMARY" },
    },
    orderBy: { updatedAt: "desc" },
    take: since ? Math.max(limit * 3, 30) : limit,
    select: { type: true, value: true, confidence: true, updatedAt: true },
  });
  // Filter in JS as well: the in-memory test DB does not implement Date
  // operators, and real Prisma can return same-millisecond rows. Rows learned
  // before the reset watermark are never used as AI memory.
  const cutoff = since ? new Date(since).getTime() : null;
  return rows
    .filter((r) => cutoff === null || new Date(r.updatedAt).getTime() >= cutoff)
    .slice(0, limit);
}

function normalizeKey(content: string): string {
  return content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 60);
}

function toMemoryType(t: "FACT" | "PREFERENCE" | "NOTE"): MemoryType {
  if (t === "PREFERENCE") return "PREFERENCE";
  if (t === "NOTE") return "IMPORTANT_NOTE";
  return "FACT";
}
