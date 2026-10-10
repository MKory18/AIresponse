/**
 * Instagram Messaging client (P5-B) — official Instagram Messaging API over
 * the Meta Graph (graph.facebook.com for page-linked accounts). Same auth
 * model as Messenger: Instagram professional account + page access token.
 *
 * Docs: Meta "Send Messages" (Instagram API with Instagram Login) —
 * POST /<IG_ID>/messages or /me/messages with recipient:{id:IGSID}.
 * Webhook object is "instagram"; verification is the same app-secret HMAC.
 */
export class InstagramApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "TRANSIENT" | "PERMANENT",
    public readonly code?: number,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "InstagramApiError";
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const PERMANENT_CODES = new Set([10, 190, 200, 2500, 551, 100]);

export interface InstagramClientOptions {
  fetchImpl?: typeof fetch;
  graphUrl?: string;
  timeoutMs?: number;
}

export class InstagramClient {
  private readonly fetchImpl: typeof fetch;
  private readonly graphUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: InstagramClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.graphUrl = (opts.graphUrl ?? "https://graph.facebook.com/v21.0").replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? 30000);
  }

  private async call<T>(path: string, params: Record<string, string>, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.graphUrl}/${path}?${new URLSearchParams(params)}`, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new InstagramApiError("Instagram request timed out", "TRANSIENT");
      }
      throw new InstagramApiError("Instagram unreachable", "TRANSIENT");
    }
    clearTimeout(timer);
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; is_transient?: boolean };
      recipient_id?: string;
      message_id?: string;
      id?: string;
      username?: string;
    };
    if (json.error) {
      const permanent =
        json.error.code === undefined || !RATE_LIMIT_CODES.has(json.error.code)
          ? (json.error.code !== undefined && PERMANENT_CODES.has(json.error.code)) ||
            json.error.is_transient === false
          : false;
      throw new InstagramApiError(
        json.error.message ?? "Instagram API error",
        permanent ? "PERMANENT" : "TRANSIENT",
        json.error.code,
        res.status
      );
    }
    if (!res.ok) {
      throw new InstagramApiError(
        `Instagram HTTP ${res.status}`,
        res.status === 429 || res.status === 408 || res.status === 425 || res.status >= 500 ? "TRANSIENT" : "PERMANENT",
        undefined,
        res.status
      );
    }
    return json as T;
  }

  async sendMessage(
    pageAccessToken: string,
    recipientId: string,
    payload: { text?: string; attachment?: { type: string; payload: { url: string } } }
  ): Promise<{ recipientId: string; messageId: string }> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      message: payload.text ? { text: payload.text } : { attachment: payload.attachment },
    };
    const json = await this.call<{ recipient_id?: string; message_id?: string }>(
      "me/messages",
      { access_token: pageAccessToken },
      body
    );
    return { recipientId: json.recipient_id ?? recipientId, messageId: json.message_id ?? "" };
  }

  /** Validates an Instagram professional account token (username lookup). */
  async getAccount(pageAccessToken: string, igId: string): Promise<{ id: string; username: string }> {
    const json = await this.call<{ id?: string; username?: string }>(
      igId,
      { fields: "id,username", access_token: pageAccessToken }
    );
    if (!json.id) throw new InstagramApiError("Instagram account not accessible", "PERMANENT");
    return { id: json.id, username: json.username ?? "" };
  }

  /**
   * Single private reply to a comment (post/reel, not live): POST
   * /PAGE-ID/messages with recipient:{comment_id}. Provider rule: exactly
   * one message, within 7 days of comment creation.
   */
  async sendPrivateReply(
    pageAccessToken: string,
    pageId: string,
    commentId: string,
    text: string
  ): Promise<{ messageId: string }> {
    const json = await this.call<{ message_id?: string }>(
      `${pageId}/messages`,
      { access_token: pageAccessToken },
      { recipient: { comment_id: commentId }, message: { text } }
    );
    return { messageId: json.message_id ?? "" };
  }

  /**
   * Comment moderation edges (per public Instagram Graph docs — shapes
   * asserted against stubs here; LIVE verification BLOCKED until an
   * approved professional account is connected):
   * - public reply: POST /{comment-id}/replies { message }
   * - hide: POST /{comment-id}/hide { hide }
   */
  async replyToComment(pageAccessToken: string, commentId: string, text: string): Promise<{ id: string }> {
    if (!text.trim()) throw new InstagramApiError("Empty comment reply", "PERMANENT");
    const json = await this.call<{ id?: string }>(
      `${commentId}/replies`,
      { access_token: pageAccessToken },
      { message: text }
    );
    if (!json.id) throw new InstagramApiError("Comment reply without id", "TRANSIENT");
    return { id: json.id };
  }

  async setCommentHidden(pageAccessToken: string, commentId: string, hidden: boolean): Promise<{ ok: boolean }> {
    await this.call(`${commentId}/hide`, { access_token: pageAccessToken }, { hide: hidden });
    return { ok: true };
  }
}

type Factory = () => InstagramClient;
let factoryOverride: Factory | null = null;

export function setInstagramClientFactory(factory: Factory | null): void {
  factoryOverride = factory;
}

export function getInstagramClient(): InstagramClient {
  return factoryOverride ? factoryOverride() : new InstagramClient();
}
