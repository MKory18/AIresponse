import { AppError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { workflowDefinitionSchema, type WorkflowDefinition } from "./workflow-schemas";

/**
 * P7 — Workflow lifecycle: draft → publish (frozen snapshot) → pause/stop →
 * rollback (publish an older snapshot as the new live state).
 *
 * Publishing ALWAYS validates the definition against the strict schema and
 * freezes an AutomationVersion snapshot; running executions keep their
 * recorded versionId, so mid-flight edits can never change behavior.
 */

export async function getOwnedWorkflow(db: Db, workspaceId: string, id: string) {
  const wf = await db.automation.findUnique({ where: { id } });
  if (!wf || wf.workspaceId !== workspaceId) throw new NotFoundError("Workflow");
  // Explicit version fetch (relation includes are not portable across test doubles).
  const versions = await db.automationVersion.findMany({
    where: { automationId: id, workspaceId },
    orderBy: { version: "desc" },
  } as never);
  return { ...wf, versions } as unknown as {
    id: string;
    workspaceId: string;
    name: string;
    description: string | null;
    trigger: string;
    conditions: unknown;
    actions: unknown;
    priority: number;
    isEnabled: boolean;
    status: string;
    version: number;
    versions: Array<Record<string, unknown>>;
  };
}

export async function publishWorkflow(db: Db, ctx: ActorContext, id: string, definition?: WorkflowDefinition) {
  const wf = await getOwnedWorkflow(db, ctx.workspaceId, id);
  const def = (definition ?? ({ trigger: wf.trigger, conditions: wf.conditions, steps: wf.actions } as unknown)) as WorkflowDefinition;
  const parsed = workflowDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(`تعريف سير العمل غير صالح: ${first?.path.join(".") ?? "?"} (${first?.message ?? "invalid"})`, 422, "WORKFLOW_INVALID");
  }
  const nextVersion = wf.version + 1;
  await db.automationVersion.create({
    data: {
      workspaceId: ctx.workspaceId,
      automationId: id,
      version: nextVersion,
      name: wf.name,
      description: wf.description,
      trigger: parsed.data.trigger,
      conditions: (parsed.data.conditions ?? {}) as never,
      actions: parsed.data.steps as never,
      priority: wf.priority,
      publishedBy: ctx.userId,
    } as never,
  });
  const updated = await db.automation.update({
    where: { id },
    data: {
      name: wf.name,
      description: wf.description,
      trigger: parsed.data.trigger,
      conditions: (parsed.data.conditions ?? {}) as never,
      actions: parsed.data.steps as never,
      priority: wf.priority,
      version: nextVersion,
      status: "PUBLISHED",
      isEnabled: true,
      publishedBy: ctx.userId,
      publishedAt: new Date(),
    } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "workflow.published",
    entityType: "Automation",
    entityId: id,
    metadata: { version: nextVersion },
  });
  return updated;
}

export async function pauseWorkflow(db: Db, ctx: ActorContext, id: string) {
  await getOwnedWorkflow(db, ctx.workspaceId, id);
  const updated = await db.automation.update({ where: { id }, data: { status: "PAUSED", isEnabled: false } } as never);
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "workflow.paused",
    entityType: "Automation",
    entityId: id,
  });
  return updated;
}

/** Stopping also cancels RUNNING/WAITING executions safely (no further steps). */
export async function stopWorkflow(db: Db, ctx: ActorContext, id: string) {
  await getOwnedWorkflow(db, ctx.workspaceId, id);
  const res = await (db as unknown as {
    automationExecution: { updateMany: (a: unknown) => Promise<{ count: number }> };
  }).automationExecution.updateMany({
    where: { automationId: id, workspaceId: ctx.workspaceId, status: { in: ["RUNNING", "WAITING"] } },
    data: { status: "CANCELLED", error: "WORKFLOW_CANCELLED:STOPPED_BY_OPERATOR", errorCategory: "CANCELLED", completedAt: new Date() },
  });
  const updated = await db.automation.update({ where: { id }, data: { status: "PAUSED", isEnabled: false } } as never);
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "workflow.stopped",
    entityType: "Automation",
    entityId: id,
    metadata: { cancelledExecutions: res.count },
  });
  return { ...updated, cancelledExecutions: res.count } as never;
}

/** Rollback = publish an older snapshot as the new live state (append-only). */
export async function rollbackWorkflow(db: Db, ctx: ActorContext, id: string, version: number) {
  const wf = await getOwnedWorkflow(db, ctx.workspaceId, id);
  const snap = wf.versions.find((v) => v.version === version);
  if (!snap) throw new NotFoundError("Workflow version");
  const def: WorkflowDefinition = {
    trigger: snap.trigger as WorkflowDefinition["trigger"],
    conditions: snap.conditions as WorkflowDefinition["conditions"],
    steps: snap.actions as WorkflowDefinition["steps"],
  };
  const parsed = workflowDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    throw new AppError("النسخة المحفوظة غير صالحة للنشر", 422, "WORKFLOW_INVALID");
  }
  const nextVersion = wf.version + 1;
  await db.automationVersion.create({
    data: {
      workspaceId: ctx.workspaceId,
      automationId: id,
      version: nextVersion,
      name: wf.name,
      description: wf.description,
      trigger: parsed.data.trigger,
      conditions: (parsed.data.conditions ?? {}) as never,
      actions: parsed.data.steps as never,
      priority: wf.priority,
      publishedBy: ctx.userId,
    } as never,
  });
  const updated = await db.automation.update({
    where: { id },
    data: {
      trigger: parsed.data.trigger,
      conditions: (parsed.data.conditions ?? {}) as never,
      actions: parsed.data.steps as never,
      version: nextVersion,
      status: "PUBLISHED",
      isEnabled: true,
      publishedBy: ctx.userId,
      publishedAt: new Date(),
    } as never,
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "workflow.rolled_back",
    entityType: "Automation",
    entityId: id,
    metadata: { fromVersion: version, publishedVersion: nextVersion, previousVersion: wf.version },
  });
  return updated;
}

export async function listWorkflowVersions(db: Db, workspaceId: string, id: string) {
  const wf = await getOwnedWorkflow(db, workspaceId, id);
  return wf.versions;
}
