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
    await writeAudit(db, input);
  } catch (err) {
    log.error({ err, action: input.action }, "audit_write_failed");
  }
}

async function writeAudit(db: AuditDb, input: AuditInput): Promise<void> {
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
}

/**
 * P15 — كتابة تدقيق صارمة: ترمي عند الفشل.
 *
 * تُستخدم داخل معاملة (transaction) مع تحديث بيانات العميل، بحيث يفشل
 * التحديث كله إذا فشل تسجيل أثر التعديل. لا تستخدمها في المسارات التي
 * يجوز أن تكمل بلا تدقيق.
 */
export async function recordAuditStrict(db: AuditDb, input: AuditInput): Promise<void> {
  await writeAudit(db, input);
}

/** تغيير حقل واحد: القيمة قبل وبعد (P15). */
export interface FieldChange {
  fieldName: string;
  beforeValue: unknown;
  afterValue: unknown;
  /** حقول إضافية توضع مع السجل (مثل scope أو customerField). */
  extra?: Record<string, unknown>;
}

function normalizeForAudit(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : item))
      .filter((item) => item !== "");
    // القوائم بلا ترتيب دلالي (وسوم/منتجات): نفس العناصر = نفس القيمة.
    return items.every((item) => typeof item === "string")
      ? [...(items as string[])].sort()
      : items;
  }
  return value;
}

/** هل القيمتان متساويتان دلاليًا؟ (فراغ = null · القوائم بلا ترتيب) */
export function auditValuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeForAudit(a)) === JSON.stringify(normalizeForAudit(b));
}

/** يبني التغييرات الفعلية فقط — لا سجل لحقل لم تتغير قيمته. */
export function changedFields(
  fields: Array<{ fieldName: string; beforeValue: unknown; afterValue: unknown; extra?: Record<string, unknown> }>
): FieldChange[] {
  return fields.filter((f) => !auditValuesEqual(f.beforeValue, f.afterValue));
}

/**
 * P15 — يسجّل كل تغيير حقل كسجل مستقل (create فقط، بلا تحديث أو استبدال).
 *
 * - سجل لكل حقل تغيّر فعليًا؛ الحقل الذي لم يتغير لا يُسجّل.
 * - يرمي عند فشل الكتابة (يُستدعى داخل معاملة مع تحديث العميل).
 * - metadata يحمل beforeValue/afterValue/fieldName/customerId ووقت السجل،
 *   وworkspaceId/actorId/createdAt من أعمدة السجل نفسها.
 */
export async function recordFieldChanges(
  db: AuditDb,
  input: {
    workspaceId: string;
    userId?: string | null;
    entityType?: string;
    entityId: string;
    ip?: string;
    action?: string;
    changes: FieldChange[];
  }
): Promise<number> {
  let written = 0;
  for (const change of changedFields(input.changes)) {
    await recordAuditStrict(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: input.action ?? "customer.field_changed",
      entityType: input.entityType ?? "Customer",
      entityId: input.entityId,
      ip: input.ip,
      metadata: {
        fieldName: change.fieldName,
        beforeValue: normalizeForAudit(change.beforeValue),
        afterValue: normalizeForAudit(change.afterValue),
        customerId: input.entityId,
        at: new Date().toISOString(),
        ...(change.extra ?? {}),
      },
    });
    written += 1;
  }
  return written;
}
