import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";

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
