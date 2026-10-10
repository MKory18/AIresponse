/**
 * TikTok Business Messaging client shape (P5-E — LOCAL ONLY).
 *
 * Status: the Business Messaging API exists publicly but requires approved
 * app access + regional eligibility + security reviews (verified in TikTok
 * API for Business docs, 2026; NOT available in EEA/CH/UK). No credentials
 * exist here, so every field below is an explicitly marked assumption used
 * ONLY for local mapping tests — nothing here proves live readiness.
 */
export class TikTokApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "TRANSIENT" | "PERMANENT",
    public readonly code?: number
  ) {
    super(message);
    this.name = "TikTokApiError";
  }
}

export interface TikTokClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export class TikTokClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: TikTokClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? "https://business-api.tiktok.com/open_api").replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? 30000);
  }

  /**
   * ASSUMED send shape (unverified live — BLOCKED): access-token authed
   * direct-message send. Kept so the adapter seam is testable locally.
   */
  async sendDirectMessage(
    accessToken: string,
    conversationId: string,
    text: string
  ): Promise<{ messageId: string }> {
    if (!text.trim()) throw new TikTokApiError("Empty TikTok message", "PERMANENT");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1.3/business/messaging/messages/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Access-Token": accessToken },
        body: JSON.stringify({ conversation_id: conversationId, message_type: "TEXT", content: { text } }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const json = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: { message_id?: string } };
      if (json.code !== 0 || !res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        throw new TikTokApiError(json.message ?? `TikTok error ${json.code ?? res.status}`, transient ? "TRANSIENT" : "PERMANENT", json.code);
      }
      return { messageId: json.data?.message_id ?? "" };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof TikTokApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new TikTokApiError("TikTok request timed out", "TRANSIENT");
      }
      throw new TikTokApiError("TikTok unreachable", "TRANSIENT");
    }
  }
}

type Factory = () => TikTokClient;
let factoryOverride: Factory | null = null;

export function setTikTokClientFactory(factory: Factory | null): void {
  factoryOverride = factory;
}

export function getTikTokClient(): TikTokClient {
  return factoryOverride ? factoryOverride() : new TikTokClient();
}
