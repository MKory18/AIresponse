import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { encryptSecret } from "@/core/crypto";
import { verifyPagesSelectionToken } from "@/modules/channels/facebook/oauth";
import { getFacebookClient } from "@/modules/channels/facebook/client";
import { AuthenticationError, ConflictError } from "@/core/errors";
import { getEnv } from "@/core/env";
import { childLogger } from "@/core/logger";

const log = childLogger("facebook.oauth");

const schema = z.object({
  selectionToken: z.string().min(20),
  pageId: z.string().min(1).max(64),
});

/**
 * POST /api/channels/facebook/select-page — persists the chosen Page as
 * Channel + ChannelAccount with an ENCRYPTED Page Access Token.
 * Uniqueness on (provider, externalAccountId) blocks double-connecting a Page.
 */
export const POST = createHandler(
  { body: schema, permission: "channels.connect" },
  async ({ auth, body, req }) => {
    let selection;
    try {
      selection = await verifyPagesSelectionToken(body.selectionToken);
    } catch {
      throw new AuthenticationError("Invalid or expired page selection token");
    }
    if (selection.workspaceId !== auth!.workspaceId || selection.userId !== auth!.userId) {
      throw new AuthenticationError("Selection token does not match the current session");
    }

    const page = selection.pages.find((p) => p.id === body.pageId);
    if (!page) throw new AuthenticationError("Selected page is not in the authorized set");

    // Duplicate Page across ANY workspace → explicit conflict.
    const existing = await prisma.channelAccount.findFirst({
      where: { provider: "FACEBOOK", externalAccountId: page.id },
      include: { channel: true },
    });
    if (existing && existing.channel.workspaceId !== auth!.workspaceId) {
      throw new ConflictError("هذه الصفحة مرتبطة بمساحة عمل أخرى");
    }

    // Upsert Channel + ChannelAccount for this workspace.
    const channel = await prisma.channel.upsert({
      where: {
        workspaceId_type_externalId: {
          workspaceId: auth!.workspaceId,
          type: "FACEBOOK",
          externalId: page.id,
        },
      },
      create: {
        workspaceId: auth!.workspaceId,
        type: "FACEBOOK",
        status: "CONNECTED",
        displayName: page.name,
        externalId: page.id,
      },
      update: { status: "CONNECTED", displayName: page.name },
    });

    const encrypted = encryptSecret(page.accessToken);
    // Page Access Tokens from /me/accounts are effectively non-expiring until
    // revoked. Never persist a stale expiry: a previous disconnect sets
    // tokenExpiresAt=now(), and leaving it would block a fresh valid token
    // with POLICY_TOKEN_EXPIRED. Only a verified real page-token expiration
    // may set this field — none is provided here, so always clear it.
    const account = await prisma.channelAccount.upsert({
      where: { channelId: channel.id },
      create: {
        channelId: channel.id,
        provider: "FACEBOOK",
        externalAccountId: page.id,
        pageName: page.name,
        encryptedCredentials: encrypted,
        connectedAt: new Date(),
        tokenExpiresAt: null,
      },
      update: {
        encryptedCredentials: encrypted,
        pageName: page.name,
        connectedAt: new Date(),
        tokenExpiresAt: null,
      },
    });
    await prisma.channel.update({ where: { id: channel.id }, data: { status: "CONNECTED" } });

    // Page-level webhook subscription — without it Meta never sends Page
    // messaging events. Attempt + verify (GET subscribed_apps) and report;
    // a failure does NOT undo the connection but is clearly logged and surfaced.
    const env = getEnv();
    let subscription: { attempted: boolean; subscribed: boolean; appId: string | null; error?: string } = {
      attempted: false,
      subscribed: false,
      appId: env.META_APP_ID ?? null,
    };
    try {
      const client = getFacebookClient();
      await client.subscribePageToApp(page.accessToken, page.id);
      const verification = await client.getPageSubscriptions(page.accessToken, page.id);
      const subscribed = verification.apps.some((a) => a.id === env.META_APP_ID);
      subscription = { attempted: true, subscribed, appId: env.META_APP_ID ?? null };
      if (subscribed) {
        log.info(
          { workspaceId: auth!.workspaceId, pageId: page.id, httpStatus: verification.httpStatus, appId: env.META_APP_ID },
          "facebook.page.subscribed_to_webhook"
        );
      } else {
        log.warn(
          { workspaceId: auth!.workspaceId, pageId: page.id, httpStatus: verification.httpStatus, apps: verification.apps.map((a) => a.id) },
          "facebook.page.subscription_not_confirmed"
        );
      }
    } catch (err) {
      subscription = { attempted: true, subscribed: false, appId: env.META_APP_ID ?? null, error: err instanceof Error ? err.message : "unknown" };
      log.warn({ workspaceId: auth!.workspaceId, pageId: page.id, error: subscription.error }, "facebook.page.subscription_failed");
    }

    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "facebook.page.connected",
      entityType: "Channel",
      entityId: channel.id,
      metadata: { pageId: page.id, pageName: page.name, pageSubscribed: subscription.subscribed },
    });
    log.info({ workspaceId: auth!.workspaceId }, "facebook.page.connected");

    // Safe fields only — never the token.
    return ok(
      {
        channelId: channel.id,
        pageId: page.id,
        pageName: page.name,
        status: channel.status,
        pageSubscribed: subscription.subscribed,
        subscription,
      },
      201
    );
  }
);

