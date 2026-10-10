import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { segmentUpdateSchema } from "@/modules/campaigns/segment-schemas";
import { previewSegmentById } from "@/modules/campaigns/segment-service";

type Params = { id: string };

export const GET = createHandler({ permission: "campaigns.read" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const row = await prisma.audienceSegment.findUnique({ where: { id } });
  if (!row || row.workspaceId !== auth!.workspaceId) return ok({ error: "NotFound" }, 404);
  return ok(row);
});

export const PATCH = createHandler(
  { body: segmentUpdateSchema, permission: "campaigns.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const row = await prisma.audienceSegment.findUnique({ where: { id } });
    if (!row || row.workspaceId !== auth!.workspaceId) return ok({ error: "NotFound" }, 404);
    const updated = await prisma.audienceSegment.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.definition !== undefined ? { definition: body.definition as never } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    } as never);
    return ok(updated);
  }
);

export const POST = createHandler(
  { body: z.object({ channelType: z.enum(["WHATSAPP", "TELEGRAM"]).optional() }).strict(), permission: "campaigns.read" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    // معاينة الشريحة: أعداد حتمية من DB — بلا تفاصيل شخصية، بلا كتابة.
    const preview = await previewSegmentById(prisma, auth!.workspaceId, id, body.channelType ?? null);
    return ok(preview);
  }
);
