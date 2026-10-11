import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { recordAudit } from "@/modules/audit/service";
import { NotFoundError } from "@/core/errors";
import { z } from "zod";

/**
 * GET /api/channels/facebook — connection health. SAFE fields only:
 * never access_token, app secret, or encrypted credentials.
 */
export const GET = createHandler(
  { permission: "channels.read" },
  async ({ auth }) => {
    const env = getEnv();
    const channels = await prisma.channel.findMany({
      where: { workspaceId: auth!.workspaceId, type: "FACEBOOK" },
      include: { account: true },
    });
    return ok({
      oauthConfigured: Boolean(env.META_APP_ID && env.META_APP_SECRET),
      connections: channels.map((c) => ({
        channelId: c.id,
        pageId: c.externalId,
        pageName: c.displayName,
        status: c.status,
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
 * Changing the page persona requires AI configuration rights. Reconnect is
 * NOT needed: the assignment takes effect for the next inbound message.
 */
export const PATCH = createHandler(
  { body: z.object({ pageId: z.string().min(1), aiPersonaId: z.string().min(1).nullable() }), permission: "ai.configure" },
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
