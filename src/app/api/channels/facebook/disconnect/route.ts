import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { recordAudit } from "@/modules/audit/service";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import { getFacebookClient } from "@/modules/channels/facebook/client";
import { disconnectFacebookPage } from "@/modules/channels/facebook/disconnect";
import { AppError, NotFoundError } from "@/core/errors";
import { z } from "zod";

/**
 * POST /api/channels/facebook/disconnect — إزالة ربط الصفحة.
 * Conversations/orders/history are preserved; only the connection is disabled.
 * Also best-effort unsubscribes the page from the Meta app so webhooks stop.
 */
export const POST = createHandler(
  { body: z.object({ pageId: z.string().min(1) }), permission: "channels.connect" },
  async ({ auth, body }) => {
    const { channelId } = await disconnectFacebookPage(prisma, getFacebookClient(), {
      workspaceId: auth!.workspaceId,
      pageId: body.pageId,
    });
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "facebook.page.disconnected",
      entityType: "Channel",
      entityId: channelId,
      metadata: { pageId: body.pageId },
    });
    return ok({ ok: true, pageId: body.pageId, status: "DISCONNECTED" });
  }
);

const testSchema = z.object({ pageId: z.string().min(1) }).optional();

/**
 * POST /api/channels/facebook/test — manual smoke test ONLY: validates the
 * stored token against the Graph API (page info). Sends nothing to customers.
 */
export const PUT = createHandler(
  { body: testSchema, permission: "channels.connect" },
  async ({ auth, body }) => {
    const pageId = body?.pageId;
    if (!pageId) throw new AppError("pageId is required", 422, "VALIDATION_ERROR");
    const channel = await prisma.channel.findFirst({
      where: { workspaceId: auth!.workspaceId, type: "FACEBOOK", externalId: pageId },
      include: { account: true },
    });
    if (!channel?.account) throw new NotFoundError("Facebook channel");

    let token: string;
    try {
      token = decryptSecret(channel.account.encryptedCredentials);
    } catch {
      throw new AppError("تعذر الاتصال بالصفحة — التوكن تالف", 422, "TOKEN_DECRYPT_FAILED");
    }
    if (token === "revoked" || channel.status !== "CONNECTED") {
      throw new AppError("تمت إزالة ربط هذه الصفحة — أعد ربطها أولًا", 422, "TOKEN_REVOKED");
    }
    const client = getFacebookClient();
    const page = await client.getPage(token, pageId);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "facebook.connection.tested",
      entityType: "Channel",
      entityId: channel.id,
      metadata: { pageId, ok: true },
    });
    return ok({ ok: true, page: { id: page.id, name: page.name } });
  }
);
