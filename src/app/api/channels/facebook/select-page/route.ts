import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { encryptSecret } from "@/core/crypto";
import { verifyPagesSelectionToken } from "@/modules/channels/facebook/oauth";
import { AuthenticationError, ConflictError } from "@/core/errors";
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
    const account = await prisma.channelAccount.upsert({
      where: { channelId: channel.id },
      create: {
        channelId: channel.id,
        provider: "FACEBOOK",
        externalAccountId: page.id,
        pageName: page.name,
        encryptedCredentials: encrypted,
        connectedAt: new Date(),
      },
      update: {
        encryptedCredentials: encrypted,
        pageName: page.name,
        connectedAt: new Date(),
      },
    });
    await prisma.channel.update({ where: { id: channel.id }, data: { status: "CONNECTED" } });

    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "facebook.page.connected",
      entityType: "Channel",
      entityId: channel.id,
      metadata: { pageId: page.id, pageName: page.name },
    });
    log.info({ workspaceId: auth!.workspaceId }, "facebook.page.connected");

    // Safe fields only — never the token.
    return ok(
      {
        channelId: channel.id,
        pageId: page.id,
        pageName: page.name,
        status: channel.status,
      },
      201
    );
  }
);

