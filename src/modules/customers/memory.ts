import { NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";

export interface MemoryResetResult {
  resetAt: Date;
  memoriesDeleted: number;
  intelDeleted: number;
  summariesCleared: number;
}

/**
 * "مسح ذاكرة العميل" — starts the AI from zero WITHOUT deleting history that
 * must be kept (orders, audit, channel identity, consent/compliance rows).
 *
 * What is removed/disabled:
 * - CustomerMemory rows (facts/preferences/summaries used as AI context).
 * - Conversation.summary (derived AI summaries).
 * - CustomerIntel snapshots (auto-extracted customer data) for their threads.
 * - A `memoryResetAt` watermark the reply pipeline uses to ignore older
 *   messages, memories and profile prefill.
 *
 * What stays: orders, invoices, audit log, channel identities, consents,
 * compliance records, and the raw messages (historical record).
 */
export async function resetCustomerMemory(
  db: Db,
  ctx: ActorContext,
  customerId: string
): Promise<MemoryResetResult> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, workspaceId: ctx.workspaceId },
    select: { id: true, workspaceId: true },
  });
  if (!customer) throw new NotFoundError("Customer");

  const conversations = (await db.conversation.findMany({
    where: { workspaceId: ctx.workspaceId, customerId },
    select: { id: true },
  })) as { id: string }[];
  const conversationIds = conversations.map((c) => c.id);
  const resetAt = new Date();

  const run = async (tx: Db) => {
    const memories = await tx.customerMemory.deleteMany({
      where: { workspaceId: ctx.workspaceId, customerId },
    });
    const intel = conversationIds.length
      ? await tx.customerIntel.deleteMany({ where: { conversationId: { in: conversationIds } } })
      : { count: 0 };
    const summaries = conversationIds.length
      ? await tx.conversation.updateMany({
          where: { id: { in: conversationIds }, workspaceId: ctx.workspaceId },
          data: { summary: null },
        })
      : { count: 0 };
    await tx.customer.update({
      where: { id: customerId },
      data: { memoryResetAt: resetAt },
    });
    return { memories: memories.count, intel: intel.count, summaries: summaries.count };
  };

  const anyDb = db as unknown as {
    $transaction?: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  };
  const counts = typeof anyDb.$transaction === "function" ? await anyDb.$transaction(run) : await run(db);

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "customer.memory_reset",
    entityType: "Customer",
    entityId: customerId,
    ip: ctx.ip,
    // Counts only — never the deleted memory content.
    metadata: {
      resetAt: resetAt.toISOString(),
      memoriesDeleted: counts.memories,
      intelDeleted: counts.intel,
      summariesCleared: counts.summaries,
    },
  });

  return {
    resetAt,
    memoriesDeleted: counts.memories,
    intelDeleted: counts.intel,
    summariesCleared: counts.summaries,
  };
}
