import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";

type Params = { id: string };

/** سوق القناة: سوريا أو الأردن (بيحكم صيغة الهاتف والمحافظات)، أو null = غير محدد. */
const bodySchema = z.object({ market: z.enum(["SY", "JO"]).nullable() });

/**
 * PATCH /api/channels/by-id/[id] — سوق الصفحة (3.6). نفس صلاحية بقية إعدادات القناة (`channels.connect`)،
 * وقناة مساحة تانية = 404 بلا تسريب. التغيير بيتسجّل بالتدقيق.
 */
export const PATCH = createHandler(
  { body: bodySchema, permission: "channels.connect" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel || channel.workspaceId !== auth!.workspaceId) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const updated = await prisma.channel.update({ where: { id }, data: { market: body.market }, select: { id: true, market: true } });
    await recordAudit(prisma as never, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "channel.market_changed",
      entityType: "Channel",
      entityId: id,
      metadata: { from: channel.market ?? null, to: body.market },
    });
    return ok(updated);
  }
);
