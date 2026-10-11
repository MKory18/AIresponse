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
      // Graph API subcodes (≥100000, e.g. 131047 outside-window / 132000 template
      // validation) are definitive rejections for this payload → PERMANENT.
      // HTTP-level 429/5xx and Meta rate-limit subcode 130429 → TRANSIENT.
      const transient =
        code === 429 || code === 130429 || (code >= 500 && code < 100000);
      throw new WhatsAppApiError(
        json.error?.message ?? `WhatsApp error ${code}`,
        transient ? "TRANSIENT" : "PERMANENT",
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

  /**
   * P9 — إرسال قالب معتمد عبر WhatsApp Business Platform (المسار الرسمي
   * للتسويق): body = { type:"template", template:{ name, language, components } }.
   * اعتماد القالب في Meta نفسه يُدار من واجهة المالك — هنا إرسال فقط.
   */
  async sendTemplate(
    token: string,
    phoneNumberId: string,
    to: string,
    template: { name: string; language: string; variables?: Record<string, string> }
  ): Promise<{ messageId: string }> {
    const bodyParams: Array<{ type: string; text: string }> = (template.variables ? Object.keys(template.variables) : [])
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => ({ type: "text", text: template.variables![k] }));
    const json = await this.call<{ messages?: { id?: string }[] }>(phoneNumberId, token, {
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(bodyParams.length ? { components: [{ type: "body", parameters: bodyParams }] } : {}),
      },
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

  /**
   * الوسائط الواردة: الخطوة الأولى — معرّف الوسيط ← رابط تحميل مؤقت
   * (GET {graph}/{media-id}) صالح ~5 دقايق وبيحتاج نفس التوكن بالتحميل.
   */
  async getMediaMeta(
    token: string,
    mediaId: string
  ): Promise<{ url: string; mimeType: string | null; fileSize: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.graphUrl}/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const json = (await res.json().catch(() => ({}))) as {
        url?: string;
        mime_type?: string;
        file_size?: number;
        error?: { message?: string; code?: number };
      };
      if (!res.ok || json.error || !json.url) {
        const code = json.error?.code ?? res.status;
        // توكن منتهي/وسيط محذوف = نهائي؛ الضغط والأعطال = مؤقت ومنعيد.
        const transient = code === 429 || code === 130429 || (code >= 500 && code < 100000);
        throw new WhatsAppApiError(
          json.error?.message ?? `WhatsApp media lookup failed (${code})`,
          transient ? "TRANSIENT" : "PERMANENT",
          code,
          res.status
        );
      }
      return {
        url: json.url,
        mimeType: json.mime_type ?? null,
        fileSize: typeof json.file_size === "number" ? json.file_size : null,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof WhatsAppApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new WhatsAppApiError("WhatsApp media lookup timed out", "TRANSIENT");
      }
      throw new WhatsAppApiError("WhatsApp unreachable", "TRANSIENT");
    }
  }

  /**
   * الخطوة التانية — تحميل البايتات من رابط ميتا بنفس التوكن.
   * `maxBytes` بيوقف التحميل قبل ما يعبّي الذاكرة: وسيط أكبر من الحد
   * بينرفض نهائيًا (ما بينعاد) بدل ما يوقع العامل.
   */
  async downloadMedia(token: string, url: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string | null }> {
    if (!/^https:\/\//i.test(url)) {
      throw new WhatsAppApiError("WhatsApp media url must be https", "PERMANENT");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        throw new WhatsAppApiError(
          `WhatsApp media download failed (${res.status})`,
          transient ? "TRANSIENT" : "PERMANENT",
          res.status,
          res.status
        );
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        throw new WhatsAppApiError(`WhatsApp media too large (${declared} > ${maxBytes})`, "PERMANENT");
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.byteLength > maxBytes) {
        throw new WhatsAppApiError(`WhatsApp media too large (${data.byteLength} > ${maxBytes})`, "PERMANENT");
      }
      return { data, mimeType: res.headers.get("content-type") };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof WhatsAppApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new WhatsAppApiError("WhatsApp media download timed out", "TRANSIENT");
      }
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
