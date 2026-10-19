import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";

type Params = { id: string };

const bodySchema = z.object({
  sendMode: z.enum(["AUTO_REPLY", "COLLECTION_ONLY"]),
});

/**
 * PATCH /api/channels/by-id/[id]/send-mode — وضع الإرسال لكل صفحة.
 * AUTO_REPLY = السلوك الحالي · COLLECTION_ONLY = جمع وتحليل بلا أي إرسال آلي.
 * لا تغيير تلقائي لأي صفحة: القرار صريح من المستخدم المخوّل.
 */
export const PATCH = createHandler(
  { body: bodySchema, permission: "channels.connect" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel || channel.workspaceId !== auth!.workspaceId) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const updated = await prisma.channel.update({
      where: { id },
      data: { sendMode: body.sendMode },
      select: { id: true, displayName: true, sendMode: true },
    });
    await recordAudit(prisma as never, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "channel.send_mode_changed",
      entityType: "Channel",
      entityId: id,
      metadata: { from: channel.sendMode, to: body.sendMode },
    });
    return ok(updated);
  }
);
