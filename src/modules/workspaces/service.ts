import { prisma } from "@/core/db/prisma";
import { AppError, ConflictError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

export async function createWorkspaceForUser(
  userId: string,
  name: string
) {
  const base = slugify(name);
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const exists = await prisma.workspace.findUnique({ where: { slug } });
    if (!exists) break;
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (i === 4) throw new ConflictError("Could not allocate workspace slug");
  }

  const workspace = await prisma.workspace.create({
    data: {
      name,
      slug,
      members: {
        create: { userId, role: "OWNER", status: "ACTIVE" },
      },
      aiSettings: { create: {} },
    },
    include: { members: true },
  });
  return workspace;
}

export function listWorkspacesForUser(userId: string) {
  return prisma.workspace.findMany({
    where: { members: { some: { userId, status: "ACTIVE" } } },
    select: { id: true, name: true, slug: true, plan: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * P3: rename / re-timezone the CURRENT workspace. The target comes from the
 * session context — never from request input — so workspaceId tampering is
 * structurally impossible here.
 */
export async function updateWorkspaceDetails(
  db: Db,
  ctx: ActorContext,
  input: { name?: string; timezone?: string }
) {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 100) {
      throw new AppError("Invalid workspace name", 422, "INVALID_WORKSPACE");
    }
    data.name = name;
  }
  if (input.timezone !== undefined) {
    const timezone = input.timezone.trim();
    if (timezone.length === 0 || timezone.length > 64) {
      throw new AppError("Invalid timezone", 422, "INVALID_WORKSPACE");
    }
    data.timezone = timezone;
  }
  if (Object.keys(data).length === 0) {
    throw new AppError("Nothing to update", 422, "EMPTY_UPDATE");
  }
  const workspace = await db.workspace.findUnique({ where: { id: ctx.workspaceId } });
  if (!workspace) throw new NotFoundError("Workspace");
  const updated = await db.workspace.update({ where: { id: ctx.workspaceId }, data });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "workspace.updated",
    entityType: "Workspace",
    entityId: ctx.workspaceId,
    metadata: { fields: Object.keys(data) },
  });
  return updated;
}
