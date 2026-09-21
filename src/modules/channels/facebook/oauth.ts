import { SignJWT, jwtVerify } from "jose";
import { getEnv } from "@/core/env";
import { AuthenticationError } from "@/core/errors";
import type { FacebookPageRef } from "./types";

/**
 * OAuth state protection: workspace+user signed into a short-lived JWT so the
 * callback cannot be replayed cross-workspace or after expiry.
 */

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().JWT_SECRET);
}

export async function createOAuthState(workspaceId: string, userId: string): Promise<string> {
  return new SignJWT({ workspaceId, userId, kind: "fb_oauth" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key());
}

export async function verifyOAuthState(
  state: string
): Promise<{ workspaceId: string; userId: string }> {
  try {
    const { payload } = await jwtVerify(state, key());
    if (payload.kind !== "fb_oauth") throw new Error("wrong kind");
    return { workspaceId: payload.workspaceId as string, userId: payload.userId as string };
  } catch {
    throw new AuthenticationError("Invalid or expired OAuth state");
  }
}

/** Signed, short-lived token carrying the discovered pages to the selector. */
export async function createPagesSelectionToken(
  workspaceId: string,
  userId: string,
  pages: FacebookPageRef[]
): Promise<string> {
  return new SignJWT({ workspaceId, userId, kind: "fb_pages", pages })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key());
}

export async function verifyPagesSelectionToken(
  token: string
): Promise<{ workspaceId: string; userId: string; pages: FacebookPageRef[] }> {
  try {
    const { payload } = await jwtVerify(token, key());
    if (payload.kind !== "fb_pages") throw new Error("wrong kind");
    return {
      workspaceId: payload.workspaceId as string,
      userId: payload.userId as string,
      pages: payload.pages as FacebookPageRef[],
    };
  } catch {
    throw new AuthenticationError("Invalid or expired page selection token");
  }
}

export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID ?? "",
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: "pages_show_list,pages_messaging,pages_manage_metadata",
  });
  return `https://www.facebook.com/${process.env.META_GRAPH_VERSION ?? "v21.0"}/dialog/oauth?${params}`;
}

export function resolveRedirectUri(origin: string): string {
  return process.env.META_REDIRECT_URI ?? `${origin}/api/channels/facebook/callback`;
}
