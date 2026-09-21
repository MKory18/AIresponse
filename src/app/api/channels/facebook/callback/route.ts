import { NextRequest, NextResponse } from "next/server";
import {
  verifyOAuthState,
  createPagesSelectionToken,
  resolveRedirectUri,
} from "@/modules/channels/facebook/oauth";
import { getFacebookClient } from "@/modules/channels/facebook/client";
import { childLogger } from "@/core/logger";

const log = childLogger("facebook.oauth");

/**
 * GET /api/channels/facebook/callback — public (Meta redirects here).
 * Exchanges the code, lists manageable Pages, and hands a signed,
 * short-lived selection token back to the UI. No credentials are persisted
 * until the explicit select-page call.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  const uiBase = process.env.APP_URL ?? req.nextUrl.origin;

  if (error || !code || !state) {
    log.warn("facebook.oauth.callback_missing_params");
    return NextResponse.redirect(`${uiBase}/channels?fb_error=callback`);
  }

  try {
    const { workspaceId, userId } = await verifyOAuthState(state);
    const client = getFacebookClient();
    const redirectUri = resolveRedirectUri(req.nextUrl.origin);
    const longLivedToken = await client.exchangeCodeForLongLivedToken(code, redirectUri);
    const pages = await client.getUserPages(longLivedToken);
    const pageRefs = pages.map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token }));

    if (pages.length === 0) {
      return NextResponse.redirect(`${uiBase}/channels?fb_error=no_pages`);
    }

    const selectionToken = await createPagesSelectionToken(workspaceId, userId, pageRefs);
    log.info({ workspaceId }, "facebook.oauth.completed");
    return NextResponse.redirect(`${uiBase}/channels?fb_pages=${encodeURIComponent(selectionToken)}`);
  } catch (err) {
    log.warn({ reason: err instanceof Error ? err.message : "unknown" }, "facebook.connection.failed");
    return NextResponse.redirect(`${uiBase}/channels?fb_error=exchange`);
  }
}
