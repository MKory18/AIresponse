import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { segmentCreateSchema } from "@/modules/campaigns/segment-schemas";

/** P9 — شرائح الجمهور: قراءة/إنشاء/معاينة (كل شيء مملوك للمساحة). */

export const GET = createHandler({ query: z.object({}).passthrough(), permission: "campaigns.read" }, async ({ auth }) => {
  const items = await prisma.audienceSegment.findMany({
    where: { workspaceId: auth!.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, name: true, description: true, definition: true, isActive: true, createdAt: true, updatedAt: true },
  });
  return ok({ items });
});

export const POST = createHandler({ body: segmentCreateSchema, permission: "campaigns.write" }, async ({ auth, body }) => {
  const row = await prisma.audienceSegment.create({
    data: {
      workspaceId: auth!.workspaceId,
      name: body.name,
      description: body.description ?? null,
      definition: body.definition as never,
      createdBy: auth!.userId,
    },
  } as never);
  return ok({ id: row.id }, 201);
});
