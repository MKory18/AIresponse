/**
 * WhatsApp Cloud API client (P5-D) — official WhatsApp Business Platform.
 *
 * Documented behavior (Meta Cloud API, verified 2026):
 * - Send: POST https://graph.facebook.com/v21.0/{PHONE-NUMBER-ID}/messages
 *   Bearer system-user token, { messaging_product:"whatsapp", to, type... }.
 * - 24h customer-service window per inbound (resets on each user message);
 *   free-form "service messages" inside, approved templates outside.
 * - Send acceptance (wamid) ≠ delivery — statuses arrive via webhooks.
 * - Webhook verification: GET hub challenge + X-Hub-Signature-256 (app secret).
 */
export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "TRANSIENT" | "PERMANENT",
    public readonly code?: number,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

export interface WhatsAppClientOptions {
  fetchImpl?: typeof fetch;
  graphUrl?: string;
  timeoutMs?: number;
}

export class WhatsAppClient {
  private readonly fetchImpl: typeof fetch;
  private readonly graphUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: WhatsAppClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.graphUrl = (opts.graphUrl ?? `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? "v21.0"}`).replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? 30000);
  }

  private async call<T>(phoneNumberId: string, token: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.graphUrl}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new WhatsAppApiError("WhatsApp request timed out", "TRANSIENT");
      }
      throw new WhatsAppApiError("WhatsApp unreachable", "TRANSIENT");
    }
    clearTimeout(timer);
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    if (json.error || !res.ok) {
      const code = json.error?.code ?? res.status;
      // Outside-window freeform (131047 family) and validation errors are
      // definitive for this payload (a template would be a different call).
      const permanent = (code >= 400 && code < 500 && code !== 429) || code === 131047;
      throw new WhatsAppApiError(
        json.error?.message ?? `WhatsApp error ${code}`,
        code === 429 || code >= 500 ? "TRANSIENT" : permanent ? "PERMANENT" : "TRANSIENT",
        code,
        res.status
      );
    }
    return json as T;
  }

  async sendText(token: string, phoneNumberId: string, to: string, text: string): Promise<{ messageId: string }> {
    const json = await this.call<{ messages?: { id?: string }[] }>(phoneNumberId, token, {
      to,
      type: "text",
      text: { body: text, preview_url: false },
    });
    return { messageId: json.messages?.[0]?.id ?? "" };
  }

  async sendMedia(
    token: string,
    phoneNumberId: string,
    to: string,
    kind: "image" | "video" | "audio" | "document",
    url: string,
    caption?: string
  ): Promise<{ messageId: string }> {
    const json = await this.call<{ messages?: { id?: string }[] }>(phoneNumberId, token, {
      to,
      type: kind,
      [kind]: { link: url, ...(caption ? { caption } : {}) },
    });
    return { messageId: json.messages?.[0]?.id ?? "" };
  }

  /** Validates a business number id + token (display number lookup). */
  async getPhoneNumber(token: string, phoneNumberId: string): Promise<{ id: string; displayPhoneNumber: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(
        `${this.graphUrl}/${phoneNumberId}?fields=id,display_phone_number&access_token=${encodeURIComponent(token)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (!res.ok) throw new WhatsAppApiError(`WhatsApp number lookup failed (${res.status})`, "PERMANENT", res.status);
      const json = (await res.json().catch(() => ({}))) as { id?: string; display_phone_number?: string };
      if (!json.id) throw new WhatsAppApiError("WhatsApp number not accessible", "PERMANENT");
      return { id: json.id, displayPhoneNumber: json.display_phone_number ?? "" };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof WhatsAppApiError) throw err;
      throw new WhatsAppApiError("WhatsApp unreachable", "TRANSIENT");
    }
  }
}

type Factory = () => WhatsAppClient;
let factoryOverride: Factory | null = null;

export function setWhatsAppClientFactory(factory: Factory | null): void {
  factoryOverride = factory;
}

export function getWhatsAppClient(): WhatsAppClient {
  return factoryOverride ? factoryOverride() : new WhatsAppClient();
}
