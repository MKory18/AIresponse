import { AppError } from "@/core/errors";

/**
 * Facebook comments via the official Graph API (P5-A).
 *
 * Documented endpoints (long-stable Graph edges):
 * - Public reply: POST /{object-id}/comments { message } — replies to a
 *   post or comment publicly.
 * - Hide/unhide: POST /{comment-id} { is_hidden: true|false }.
 * - Private reply: POST /{PAGE-ID}/messages { recipient: { comment_id },
 *   message } — provider rules (Meta Private Replies, verified 2026):
 *   exactly ONE message per comment, within 7 days of comment creation;
 *   the thread continues in the 24h window only if the user responds.
 */
export class FacebookCommentsError extends AppError {
  constructor(message: string, retryable: boolean) {
    super(message, retryable ? 502 : 422, retryable ? "FB_COMMENT_TRANSIENT" : "FB_COMMENT_REJECTED");
  }
}

export interface CommentsClientOptions {
  fetchImpl?: typeof fetch;
  graphUrl?: string;
  timeoutMs?: number;
}

export class FacebookCommentsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly graphUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: CommentsClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Same convention as FacebookClient: host fixed, version overridable.
    this.graphUrl = (opts.graphUrl ?? `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? "v21.0"}`).replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? 30000);
  }

  private async call<T>(path: string, token: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.graphUrl}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new FacebookCommentsError("Comment request timed out", true);
      }
      throw new FacebookCommentsError("Comment request unreachable", true);
    }
    clearTimeout(timer);
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; is_transient?: boolean };
      id?: string;
      message_id?: string;
    };
    if (json.error || !res.ok) {
      const transient =
        json.error?.is_transient === true ||
        res.status === 429 || res.status === 408 || res.status === 425 || res.status >= 500;
      throw new FacebookCommentsError(json.error?.message ?? `Comment request failed (${res.status})`, transient);
    }
    return json as T;
  }

  /** Public reply under a post or comment. */
  async replyPublic(pageAccessToken: string, objectId: string, text: string): Promise<{ id: string }> {
    if (!text.trim()) throw new FacebookCommentsError("Empty comment reply", false);
    const json = await this.call<{ id?: string }>(`${objectId}/comments`, pageAccessToken, { message: text });
    if (!json.id) throw new FacebookCommentsError("Comment reply without id", true);
    return { id: json.id };
  }

  /** Hide (or unhide) a comment. Requires page manage rights on the token. */
  async setHidden(pageAccessToken: string, commentId: string, hidden: boolean): Promise<{ ok: boolean }> {
    await this.call(`${commentId}`, pageAccessToken, { is_hidden: hidden });
    return { ok: true };
  }

  /** Single private reply (provider enforces one-per-comment + 7-day window). */
  async replyPrivate(
    pageAccessToken: string,
    pageId: string,
    commentId: string,
    text: string
  ): Promise<{ messageId: string }> {
    if (!text.trim()) throw new FacebookCommentsError("Empty private reply", false);
    const json = await this.call<{ message_id?: string }>(`${pageId}/messages`, pageAccessToken, {
      recipient: { comment_id: commentId },
      message: { text },
    });
    return { messageId: json.message_id ?? "" };
  }
}

type Factory = () => FacebookCommentsClient;
let factoryOverride: Factory | null = null;

export function setFacebookCommentsClientFactory(factory: Factory | null): void {
  factoryOverride = factory;
}

export function getFacebookCommentsClient(): FacebookCommentsClient {
  return factoryOverride ? factoryOverride() : new FacebookCommentsClient();
}
