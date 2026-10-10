/**
 * Telegram Bot API client (P5-C) — official Bot API only. No personal
 * sessions, no scraping. Base: https://api.telegram.org/bot<token>/<method>.
 *
 * Docs: core.telegram.org/bots/api — sendMessage, getMe, getFile, setWebhook.
 * Errors: { ok:false, error_code, description, parameters:{ retry_after? } }.
 * Rate guidance: ~30 msg/s global, ~1 msg/s per chat; 429 carries retry_after.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "TRANSIENT" | "PERMANENT",
    public readonly code?: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export interface TelegramClientOptions {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  timeoutMs?: number;
}

export class TelegramClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: TelegramClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiUrl = (opts.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? 30000);
  }

  private url(token: string, method: string): string {
    return `${this.apiUrl}/bot${token}/${method}`;
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(token, method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new TelegramApiError("Telegram request timed out", "TRANSIENT");
      }
      throw new TelegramApiError("Telegram unreachable", "TRANSIENT");
    }
    clearTimeout(timer);
    const json = (await res.json().catch(() => ({ ok: false }))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (json.ok !== true) {
      const code = json.error_code ?? res.status;
      const retryAfterMs =
        typeof json.parameters?.retry_after === "number" ? json.parameters.retry_after * 1000 : undefined;
      // 400/401/403/404: bad request, bad/revoked token, blocked/unknown
      // chat (permanent for this payload). 429/5xx/network: transient.
      const permanent = code >= 400 && code < 500 && code !== 429;
      throw new TelegramApiError(
        json.description ?? `Telegram error ${code}`,
        code === 429 || code >= 500 ? "TRANSIENT" : permanent ? "PERMANENT" : "TRANSIENT",
        code,
        retryAfterMs
      );
    }
    return (json.result ?? {}) as T;
  }

  async getMe(botToken: string): Promise<{ id: number; username: string }> {
    const r = await this.call<{ id?: number; username?: string }>(botToken, "getMe", {});
    if (!r.id) throw new TelegramApiError("Invalid bot token", "PERMANENT", 401);
    return { id: r.id, username: r.username ?? "" };
  }

  async sendMessage(
    botToken: string,
    chatId: string | number,
    payload: { text?: string; photo?: string; document?: string; caption?: string }
  ): Promise<{ messageId: number }> {
    const method = payload.photo ? "sendPhoto" : payload.document ? "sendDocument" : "sendMessage";
    const body: Record<string, unknown> = { chat_id: chatId };
    if (method === "sendMessage") body.text = payload.text ?? "";
    else {
      body[payload.photo ? "photo" : "document"] = payload.photo ?? payload.document;
      if (payload.caption || payload.text) body.caption = payload.caption ?? payload.text;
    }
    const r = await this.call<{ message_id?: number }>(botToken, method, body);
    return { messageId: r.message_id ?? 0 };
  }

  /** Registers/refreshes the webhook (operator needs a public HTTPS URL). */
  async setWebhook(botToken: string, url: string, secretToken: string): Promise<{ ok: boolean }> {
    await this.call(botToken, "setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
    return { ok: true };
  }

  async deleteWebhook(botToken: string): Promise<{ ok: boolean }> {
    await this.call(botToken, "deleteWebhook", { drop_pending_updates: false });
    return { ok: true };
  }
}

type Factory = () => TelegramClient;
let factoryOverride: Factory | null = null;

export function setTelegramClientFactory(factory: Factory | null): void {
  factoryOverride = factory;
}

export function getTelegramClient(): TelegramClient {
  return factoryOverride ? factoryOverride() : new TelegramClient();
}
