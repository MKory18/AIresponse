import { prisma } from "@/core/db/prisma";
import { ConflictError } from "@/core/errors";

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
