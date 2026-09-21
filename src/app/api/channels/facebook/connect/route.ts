import { NextRequest, NextResponse } from "next/server";
import { createHandler } from "@/core/api/handler";
import { createOAuthState, buildAuthorizeUrl, resolveRedirectUri } from "@/modules/channels/facebook/oauth";
import { recordAudit } from "@/modules/audit/service";
import { prisma } from "@/core/db/prisma";
import { childLogger } from "@/core/logger";

const log = childLogger("facebook.oauth");

/**
 * GET /api/channels/facebook/connect — starts the OAuth flow.
 * RBAC: channels.connect. State is a signed short-lived JWT binding the
 * workspace+user so the callback can never be replayed cross-workspace.
 */
export const GET = createHandler(
  { permission: "channels.connect" },
  async ({ auth, req }) => {
    const origin = req.headers.get("origin") ?? req.nextUrl.origin;
    const redirectUri = resolveRedirectUri(origin);
    const state = await createOAuthState(auth!.workspaceId, auth!.userId);
    await recordAudit(prisma, {
      workspaceId: auth!.workspaceId,
      userId: auth!.userId,
      action: "facebook.oauth.started",
    });
    log.info({ workspaceId: auth!.workspaceId }, "facebook.oauth.started");
    return NextResponse.redirect(buildAuthorizeUrl(state, redirectUri));
  }
);
