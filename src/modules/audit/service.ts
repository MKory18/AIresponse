import { childLogger } from "@/core/logger";
import type { Prisma } from "@prisma/client";

const log = childLogger("audit");

export interface AuditInput {
  workspaceId: string;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

type AuditDb = Pick<Prisma.TransactionClient, "auditLog">;

/**
 * Fire-and-forget audit logging. Never throws — an audit failure must not
 * break the user-facing operation.
 */
export async function recordAudit(db: AuditDb, input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        ip: input.ip,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    log.error({ err, action: input.action }, "audit_write_failed");
  }
}
