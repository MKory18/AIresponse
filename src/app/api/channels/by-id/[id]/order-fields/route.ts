import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import { normalizeOrderFields } from "@/modules/orders/required-fields";

/**
 * P19 — الحقول المطلوبة لإكمال الطلب لهذه الصفحة.
 *
 * product + quantity دائمًا مطلوبان (خادميًا، لا يمكن إزالتهما)؛ المالك يختار
 * phone/address/name. الحفظ لا يمسّ الطلبات القائمة ولا المسودات المكتملة.
 */
type Params = { id: string };

export const GET = createHandler(
  { permission: "channels.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const channel = await prisma.channel.findFirst({
      where: { id, workspaceId: auth!.workspaceId },
      select: { id: true, type: true, displayName: true, orderRequiredFields: true },
    });
    if (!channel) throw new NotFoundError("Channel");
    return ok({
      channelId: channel.id,
      displayName: channel.displayName,
      fields: normalizeOrderFields(channel.orderRequiredFields),
    });
  }
);

export const PUT = createHandler(
  { permission: "settings.manage", body: z.object({ fields: z.array(z.string().max(32)).max(10) }) },
  async ({ auth, params, body }) => {
    const { id } = params as Params;
    const channel = await prisma.channel.findFirst({
      where: { id, workspaceId: auth!.workspaceId },
      select: { id: true },
    });
    if (!channel) throw new NotFoundError("Channel");

    const fields = normalizeOrderFields(body.fields);
    await prisma.channel.update({
      where: { id: channel.id },
      data: { orderRequiredFields: fields },
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "channel.order_fields_updated",
      entityType: "Channel",
      entityId: channel.id,
      metadata: { fields },
    });
    return ok({ channelId: channel.id, fields });
  }
);
