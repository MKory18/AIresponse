import { getEnv } from "@/core/env";
import { FacebookApiError } from "./types";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Non-retryable Graph error codes (token/permission/recipient/policy). */
const PERMANENT_CODES = new Set([10, 190, 200, 2500, 551, 100, 613]);

export interface SendPayload {
  text?: string;
  attachment?: { type: "image" | "video" | "audio" | "file"; payload: { url: string } };
}

export interface SendMessageResult {
  recipientId: string;
  messageId: string;
}

export interface FacebookClientOptions {
  fetchImpl?: typeof fetch;
  graphUrl?: string;
}

/**
 * Typed Facebook Graph API client. The ONLY place in the system that talks to
 * Meta. Callers never see raw HTTP; errors are normalized to
 * FacebookApiError(TRANSIENT|PERMANENT) so retry policy stays sane.
 */
export class FacebookClient {
  private readonly fetchImpl: typeof fetch;
  private readonly graphUrl: string;

  constructor(opts: FacebookClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.graphUrl = opts.graphUrl ?? GRAPH_URL;
  }

  private async call<T>(path: string, params: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.graphUrl}/${path}?${new URLSearchParams(params)}`, {
        method: "POST",
      });
    } catch (err) {
      throw new FacebookApiError(
        `Network failure calling Graph API: ${err instanceof Error ? err.message : "unknown"}`,
        "TRANSIENT"
      );
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message: string; code?: number; error_subcode?: number; is_transient?: boolean };
      recipient_id?: string;
      message_id?: string;
      data?: T;
      id?: string;
      name?: string;
      access_token?: string;
    };

    if (json.error) {
      const permanent =
        (json.error.code !== undefined && PERMANENT_CODES.has(json.error.code)) ||
        json.error.is_transient === false;
      throw new FacebookApiError(
        json.error.message ?? "Graph API error",
        permanent ? "PERMANENT" : "TRANSIENT",
        json.error.code,
        json.error.error_subcode
      );
    }
    return json as unknown as T;
  }

  /** Send API — messages endpoint. */
  async sendMessage(pageAccessToken: string, recipientId: string, payload: SendPayload): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: payload.text
        ? { text: payload.text }
        : { attachment: payload.attachment },
    };
    const res = await this.call<{ recipient_id: string; message_id: string }>(
      "me/messages",
      { access_token: pageAccessToken, messaging_type: "RESPONSE", recipient: JSON.stringify(body.recipient), message: JSON.stringify(body.message) }
    );
    if (!res?.message_id) throw new FacebookApiError("Graph API returned no message_id", "TRANSIENT");
    return { recipientId: res.recipient_id ?? recipientId, messageId: res.message_id };
  }

  async getPage(pageAccessToken: string, pageId: string): Promise<{ id: string; name: string }> {
    try {
      const res = await fetch(`${this.graphUrl}/${pageId}?fields=id,name&access_token=${encodeURIComponent(pageAccessToken)}`);
      const json = (await res.json()) as { id?: string; name?: string; error?: { message: string; code?: number } };
      if (json.error || !json.id) {
        throw new FacebookApiError(json.error?.message ?? "Page fetch failed", json.error?.code === 190 ? "PERMANENT" : "TRANSIENT", json.error?.code);
      }
      return { id: json.id, name: json.name ?? pageId };
    } catch (err) {
      if (err instanceof FacebookApiError) throw err;
      throw new FacebookApiError("Network failure fetching page", "TRANSIENT");
    }
  }

  /**
   * Page-level webhook subscription: without this Meta never delivers Page
   * messaging events to our app, even with a valid Page Access Token.
   * POST /{page-id}/subscribed_apps with subscribed_fields for messaging.
   * Idempotent — re-subscribing an already-subscribed Page returns success.
   */
  async subscribePageToApp(pageAccessToken: string, pageId: string): Promise<{ subscribed: boolean }> {
    const res = await this.call<{ success?: boolean }>(
      `${pageId}/subscribed_apps`,
      {
        access_token: pageAccessToken,
        subscribed_fields: "messages,messaging_postbacks,messaging_optins,messaging_referrals,message_reactions",
      }
    );
    if (!res?.success) {
      throw new FacebookApiError("Graph did not confirm page subscription", "PERMANENT");
    }
    return { subscribed: true };
  }

  /**
   * Verification step: GET /{page-id}/subscribed_apps and return the apps
   * (id + name) the Page is currently subscribed to. Callers match our
   * META_APP_ID against this list to confirm delivery will work.
   */
  async getPageSubscriptions(pageAccessToken: string, pageId: string): Promise<{ httpStatus: number; apps: { id: string; name?: string }[] }> {
    try {
      const res = await this.fetchImpl(`${this.graphUrl}/${pageId}/subscribed_apps?fields=id,name&access_token=${encodeURIComponent(pageAccessToken)}`);
      const json = (await res.json().catch(() => ({}))) as {
        data?: { id: string; name?: string }[];
        error?: { message: string; code?: number };
      };
      if (json.error) {
        throw new FacebookApiError(json.error.message ?? "Subscription fetch failed", json.error?.code === 190 ? "PERMANENT" : "TRANSIENT", json.error?.code);
      }
      return { httpStatus: res.status, apps: json.data ?? [] };
    } catch (err) {
      if (err instanceof FacebookApiError) throw err;
      throw new FacebookApiError("Network failure fetching page subscriptions", "TRANSIENT");
    }
  }

  /** OAuth code → long-lived user token. */
  async exchangeCodeForLongLivedToken(code: string, redirectUri: string): Promise<string> {
    const env = getEnv();
    const res = await fetch(
      `${this.graphUrl}/oauth/access_token?${new URLSearchParams({
        client_id: env.META_APP_ID ?? "",
        client_secret: env.META_APP_SECRET ?? "",
        redirect_uri: redirectUri,
        code,
      })}`
    );
    const json = (await res.json()) as { access_token?: string; error?: { message: string; code?: number } };
    if (!json.access_token) {
      throw new FacebookApiError(json.error?.message ?? "Code exchange failed", "PERMANENT", json.error?.code);
    }
    // Exchange short-lived → long-lived.
    const ext = await fetch(
      `${this.graphUrl}/oauth/access_token?${new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: env.META_APP_ID ?? "",
        client_secret: env.META_APP_SECRET ?? "",
        fb_exchange_token: json.access_token,
      })}`
    );
    const extJson = (await ext.json()) as { access_token?: string; expires_in?: number };
    if (!extJson.access_token) {
      throw new FacebookApiError("Long-lived token exchange failed", "PERMANENT");
    }
    return extJson.access_token;
  }

  /** Pages the user manages, each with its own Page Access Token. */
  async getUserPages(userAccessToken: string): Promise<{ id: string; name: string; access_token: string }[]> {
    const res = await fetch(`${this.graphUrl}/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
    const json = (await res.json()) as {
      data?: { id: string; name: string; access_token: string }[];
      error?: { message: string; code?: number };
    };
    if (json.error) throw new FacebookApiError(json.error.message, "PERMANENT", json.error.code);
    return json.data ?? [];
  }
}

const globalForFb = globalThis as typeof globalThis & {
  __acreFbClientFactory?: () => FacebookClient;
};

export function setFacebookClientFactory(factory: () => FacebookClient) {
  globalForFb.__acreFbClientFactory = factory;
}

export function getFacebookClient(): FacebookClient {
  if (globalForFb.__acreFbClientFactory) return globalForFb.__acreFbClientFactory();
  return new FacebookClient();
}
