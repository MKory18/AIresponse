import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { recordAudit } from "@/modules/audit/service";
import { NotFoundError } from "@/core/errors";
import { z } from "zod";
import { normalizeOrderFields } from "@/modules/orders/required-fields";
import { archiveFacebookPage, visibleChannelsWhere } from "@/modules/channels/facebook/archive";

/**
 * GET /api/channels/facebook — connection health. SAFE fields only:
 * never access_token, app secret, or encrypted credentials.
 */
export const GET = createHandler(
  { permission: "channels.read" },
  async ({ auth }) => {
    const env = getEnv();
    // الصفحة اللي شالها المالك ما بتظهر — بس محادثاتها بتضل.
    const channels = await prisma.channel.findMany({
      where: visibleChannelsWhere(auth!.workspaceId),
      include: { account: true },
    });
    return ok({
      oauthConfigured: Boolean(env.META_APP_ID && env.META_APP_SECRET),
      connections: channels.map((c) => ({
        channelId: c.id,
        pageId: c.externalId,
        pageName: c.displayName,
        status: c.status,
        // P19 — الحقول المطلوبة لإكمال الطلب لهذه الصفحة.
        orderRequiredFields: normalizeOrderFields(c.orderRequiredFields),
        aiPersonaId: (c as { aiPersonaId?: string | null }).aiPersonaId ?? null,
        connectedAt: c.account?.connectedAt ?? null,
        lastWebhookAt: c.account?.lastWebhookAt ?? null,
        lastSendAt: c.account?.lastSendAt ?? null,
        tokenStatus: c.account?.tokenExpiresAt
          ? c.account.tokenExpiresAt > new Date() ? "VALID" : "EXPIRED"
          : "LONG_LIVED",
      })),
    });
  }
);

/**
 * PATCH /api/channels/facebook — assign an AI persona to a page.
 * Changing the page persona requires channel-connect rights (same as by-id/[id]/persona). Reconnect is
 * NOT needed: the assignment takes effect for the next inbound message.
 */
export const PATCH = createHandler(
  { body: z.object({ pageId: z.string().min(1), aiPersonaId: z.string().min(1).nullable() }), permission: "channels.connect" },
  async ({ auth, body }) => {
    const channel = await prisma.channel.findFirst({
      where: { workspaceId: auth!.workspaceId, type: "FACEBOOK", externalId: body.pageId },
    });
    if (!channel) throw new NotFoundError("Facebook channel");
    if (body.aiPersonaId) {
      const persona = await prisma.persona.findFirst({
        where: { id: body.aiPersonaId, workspaceId: auth!.workspaceId },
        select: { id: true },
      });
      if (!persona) throw new NotFoundError("Persona");
    }
    const updated = await prisma.channel.update({
      where: { id: channel.id },
      data: { aiPersonaId: body.aiPersonaId },
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "facebook.page.persona_assigned",
      entityType: "Channel",
      entityId: channel.id,
      metadata: { pageId: body.pageId, aiPersonaId: body.aiPersonaId },
    });
    return ok({ ok: true, channelId: updated.id, aiPersonaId: updated.aiPersonaId });
  }
);

/**
 * DELETE /api/channels/facebook — شيل صفحة موقوفة من القائمة.
 *
 * ⚠️ مش حذف: صف القناة بيضل. `Conversation.channel` عليها `onDelete: Cascade`،
 * فحذف الصف بيمسح كل محادثات الصفحة وطلباتها بضربة وحدة.
 * 🔧 أرشفة — بتختفي من القائمة والسجل بيضل كامل، والربط من جديد بيرجّعها.
 * والمربوطة ما بتنشال أبدًا: لازم إزالة الربط أول.
 */
export const DELETE = createHandler(
  { body: z.object({ pageId: z.string().min(1) }), permission: "channels.connect" },
  async ({ auth, body }) => {
    const res = await archiveFacebookPage(prisma, { workspaceId: auth!.workspaceId, pageId: body.pageId });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "facebook.page.archived",
      entityType: "Channel",
      entityId: res.channelId,
      metadata: { pageId: body.pageId, historyKept: true },
    });
    return ok({ ok: true, pageId: body.pageId, archived: true });
  }
);
