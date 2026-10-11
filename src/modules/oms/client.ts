import crypto from "node:crypto";
import { decryptSecret, timingSafeEqual } from "@/core/crypto";
import { AppError } from "@/core/errors";

export interface OmsProduct {
  sku: string;
  name: string;
  price: number;
  currency: string;
  wholesalePrice?: number | null;
  discountCap?: number | null;
  offers?: OmsOffer[];
  complementarySkus?: string[];
  stockStatus?: string;
}

export interface OmsOffer {
  title: string;
  quantity: number;
  price: number;
  saving: number;
  remainingQty?: number | null;
  expiresAt?: string | null;
}

export interface OmsCustomer {
  phone: string;
  name?: string | null;
  isBlacklisted?: boolean;
  totalOrders?: number;
  totalValue?: number;
}

/** P12 — لقطة الإسناد التي تنتقل مع الطلب للـ OMS (مصدرها الوحيد للميديا باير والكليبر). */
export interface OmsOrderAttribution {
  method: "AD" | "CODE" | "NONE";
  adId?: string | null;
  adSourceType?: string | null;
  /** رمز نقرة واتساب — يُفك تشفيره لحظة الإرسال فقط ولا يُسجَّل. */
  ctwaClid?: string | null;
  refCode?: string | null;
  refCodeAt?: string | null;
  touchAt?: string | null;
  pageId?: string | null;
  /** معرّف الزبون على الصفحة (ماسنجر/إنستغرام) — للتحويلات فقط. */
  psid?: string | null;
  wabaId?: string | null;
  conversationRef?: string | null;
}

export interface OmsOrderPayload {
  idempotencyKey: string;
  orderNumber: string;
  customer: { name: string; phone: string; address: string; province: string };
  items: Array<{ sku: string; name: string; unitPrice: number; quantity: number; subtotal: number }>;
  totals: { subtotal: number; discount: number; deliveryFee: number; total: number; currency: string };
  adSource?: string | null;
  notes?: string | null;
  conversationId?: string | null;
  /** P12 — القناة بأسماء العقود (whatsapp · messenger · …). */
  channel?: string | null;
  attribution?: OmsOrderAttribution | null;
}

/** P12 — legacy: النقاط المؤقتة /oms/* · v1: عقد /api/v1 الموحّد للمنظومة. */
export type OmsApiVersion = "legacy" | "v1";

export interface OmsClientDeps {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout ms (default 15000, env OMS_REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** GET retry budget (default 3 attempts total). POSTs never retry on answers. */
  maxGetAttempts?: number;
  /** P12 — لهجة الـ API (افتراضي legacy للحفاظ على سلوك الاتصالات القديمة). */
  apiVersion?: OmsApiVersion;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

/** v1 → الشكل الداخلي (مبالغ v1 نص عشري؛ الداخلي أرقام كما يتوقع sync). */
export function mapV1Product(raw: Record<string, unknown>): OmsProduct {
  const offers = Array.isArray(raw.offers) ? (raw.offers as Array<Record<string, unknown>>) : [];
  return {
    sku: String(raw.code ?? raw.sku ?? ""),
    name: String(raw.name ?? ""),
    price: num(raw.price) ?? NaN,
    currency: String(raw.currency ?? ""),
    wholesalePrice: num(raw.wholesale_price),
    discountCap: num(raw.discount_cap),
    offers: offers.map((o) => ({
      title: String(o.title ?? ""),
      quantity: num(o.quantity) ?? 1,
      price: num(o.price) ?? 0,
      saving: num(o.saving) ?? 0,
      remainingQty: num(o.remaining_qty),
      expiresAt: o.expires_at ? String(o.expires_at) : null,
    })),
    complementarySkus: Array.isArray(raw.complements) ? (raw.complements as unknown[]).map(String) : [],
    stockStatus: raw.stock_status ? String(raw.stock_status) : undefined,
  };
}

function money2(n: number): string {
  const cents = Math.round(n * 100);
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** الشكل الداخلي → جسم POST /api/v1/orders (مبالغ نص عشري بخانتين). */
export function toV1OrderBody(p: OmsOrderPayload): Record<string, unknown> {
  const a = p.attribution;
  return {
    external_ref: p.orderNumber,
    source: "replies",
    channel: p.channel ?? null,
    customer: { name: p.customer.name, phone: p.customer.phone, city: p.customer.province, address: p.customer.address },
    items: p.items.map((i) => ({
      product_code: i.sku,
      name: i.name,
      quantity: i.quantity,
      unit_price: money2(i.unitPrice),
      line_total: money2(i.subtotal),
    })),
    totals: {
      subtotal: money2(p.totals.subtotal),
      discount: money2(p.totals.discount),
      delivery_fee: money2(p.totals.deliveryFee),
      total: money2(p.totals.total),
      currency: p.totals.currency,
    },
    notes: p.notes ?? null,
    attribution: a
      ? {
          method: a.method,
          ad_id: a.adId ?? null,
          ad_source_type: a.adSourceType ?? null,
          ctwa_clid: a.ctwaClid ?? null,
          ref_code: a.refCode ?? null,
          ref_code_at: a.refCodeAt ?? null,
          touch_at: a.touchAt ?? null,
          page_id: a.pageId ?? null,
          psid: a.psid ?? null,
          waba_id: a.wabaId ?? null,
          conversation_ref: a.conversationRef ?? null,
        }
      : { method: "NONE" },
  };
}

function resolveTimeoutMs(explicit?: number): number {
  if (explicit !== undefined) return Math.max(1000, explicit);
  const fromEnv = Number(process.env.OMS_REQUEST_TIMEOUT_MS ?? 15000);
  return Number.isFinite(fromEnv) && fromEnv >= 1000 ? fromEnv : 15000;
}

/**
 * OmsClient — the ONLY outbound path to the OMS. Token scope is read + create
 * confirmed order + confirmation result + note (nothing else). Never changes
 * OMS state, prices, or fulfillment directly.
 *
 * Reliability contract (P2):
 * - Every attempt is bounded by timeoutMs (no hung requests).
 * - GETs retry transient failures (network/timeout/429/5xx) with backoff.
 * - POST createOrder retries ONLY on ambiguous outcomes (network error or
 *   timeout — the OMS may have accepted) reusing the SAME idempotencyKey, so
 *   a standards-compliant OMS creates exactly one order. Definitive answers
 *   (4xx/5xx responses) are never retried.
 * - Nothing sensitive is logged here (no token, no customer payloads).
 */
export class OmsClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxGetAttempts: number;
  readonly apiVersion: OmsApiVersion;

  constructor(deps: OmsClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = resolveTimeoutMs(deps.timeoutMs);
    this.maxGetAttempts = Math.max(1, deps.maxGetAttempts ?? 3);
    this.apiVersion = deps.apiVersion ?? "legacy";
  }

  private async fetchOnce(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Belt-and-braces: race a timeout rejection too, so a fetch
    // implementation that ignores AbortSignal still cannot hang us.
    let timeout: NodeJS.Timeout | undefined;
    const timeoutGuard = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new AppError("OMS request timed out", 502, "OMS_TIMEOUT")), this.timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          try {
            return await this.fetchImpl(`${this.baseUrl}${path}`, {
              method,
              headers: {
                authorization: `Bearer ${this.token}`,
                "content-type": "application/json",
                ...extraHeaders,
              },
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: controller.signal,
              // P12: رابط يحوّل = رابط يشير لمكان تاني (التوكن وبيانات الزبون لا تتبعه).
              redirect: "manual",
            });
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              throw new AppError("OMS request timed out", 502, "OMS_TIMEOUT");
            }
            throw new AppError("OMS unreachable", 502, "OMS_UNREACHABLE");
          }
        })(),
        timeoutGuard,
      ]);
    } finally {
      clearTimeout(timer);
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private static isTransientStatus(status: number): boolean {
    return status === 429 || status === 408 || status === 425 || status >= 500;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const isWrite = method !== "GET";
    const attempts = isWrite ? 1 : this.maxGetAttempts;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchOnce(method, path, body, extraHeaders);
      } catch (err) {
        lastErr = err;
        // Ambiguous outcome: only GETs retry here; POST retries are decided
        // by the caller (handoff), which reuses the idempotency key.
        if (!isWrite && attempt < attempts) {
          await this.sleep(Math.min(300 * 2 ** (attempt - 1), 3000));
          continue;
        }
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        throw new AppError("OMS token rejected", 502, "OMS_AUTH_FAILED");
      }
      if (res.status >= 300 && res.status < 400) {
        throw new AppError("OMS redirected the request (refused)", 502, "OMS_REDIRECT_REFUSED");
      }
      if (!res.ok) {
        if (!isWrite && OmsClient.isTransientStatus(res.status) && attempt < attempts) {
          await this.sleep(Math.min(300 * 2 ** (attempt - 1), 3000));
          continue;
        }
        throw new AppError(`OMS error ${res.status}`, 502, "OMS_ERROR");
      }
      return (await res.json()) as T;
    }
    throw lastErr instanceof AppError ? lastErr : new AppError("OMS unreachable", 502, "OMS_UNREACHABLE");
  }

  async getProducts(): Promise<{ products: OmsProduct[] }> {
    if (this.apiVersion === "v1") {
      const res = await this.request<{ items?: unknown }>("GET", "/api/v1/products?for=replies");
      const items = Array.isArray(res?.items) ? (res.items as Array<Record<string, unknown>>) : null;
      // شكل غير متوقع = null (sync يرفضه كـ OMS_BAD_RESPONSE قبل أي كتابة).
      return { products: items ? items.map(mapV1Product) : (null as unknown as OmsProduct[]) };
    }
    return this.request("GET", "/oms/products");
  }

  async getCustomer(phone: string): Promise<OmsCustomer | null> {
    if (this.apiVersion === "v1") {
      const res = await this.request<Record<string, unknown> | null>("GET", `/api/v1/customers/lookup?phone=${encodeURIComponent(phone)}`);
      if (!res || res.exists === false) return null;
      return {
        phone,
        isBlacklisted: res.blacklisted === true,
        totalOrders: num(res.orders_count) ?? undefined,
        totalValue: num(res.total_value) ?? undefined,
      };
    }
    return this.request("GET", `/oms/customer?phone=${encodeURIComponent(phone)}`);
  }

  async getOrder(omsOrderId: string): Promise<{ id: string; status: string; shipmentStatus?: string | null; orderNumber?: string | null }> {
    if (this.apiVersion === "v1") {
      const res = await this.request<Record<string, unknown>>("GET", `/api/v1/orders/${encodeURIComponent(omsOrderId)}`);
      return {
        id: String(res.order_id ?? omsOrderId),
        status: String(res.status ?? ""),
        shipmentStatus: res.shipping_status ? String(res.shipping_status) : null,
        orderNumber: res.order_number ? String(res.order_number) : null,
      };
    }
    return this.request("GET", `/oms/order/${encodeURIComponent(omsOrderId)}`);
  }

  /** Idempotent: the OMS must deduplicate on `idempotencyKey`. */
  async createOrder(payload: OmsOrderPayload): Promise<{ id: string; status: string; orderNumber?: string | null }> {
    if (this.apiVersion === "v1") {
      const res = await this.request<Record<string, unknown>>("POST", "/api/v1/orders", toV1OrderBody(payload), {
        "idempotency-key": payload.idempotencyKey,
        "x-request-id": `rep_${payload.orderNumber}`.slice(0, 64),
      });
      const id = res?.order_id ? String(res.order_id) : "";
      if (!id) throw new AppError("OMS returned no order id", 502, "OMS_BAD_RESPONSE");
      return { id, status: String(res.status ?? "NEW"), orderNumber: res.order_number ? String(res.order_number) : null };
    }
    return this.request("POST", "/oms/orders", payload);
  }

  async postNote(payload: { orderId: string; kind: string; note: string }): Promise<{ ok: boolean }> {
    if (this.apiVersion === "v1") {
      await this.request("POST", `/api/v1/orders/${encodeURIComponent(payload.orderId)}/notes`, { kind: payload.kind, note: payload.note }, {
        "idempotency-key": `note-${payload.orderId}-${crypto.createHash("sha256").update(`${payload.kind}|${payload.note}`).digest("hex").slice(0, 24)}`,
      });
      return { ok: true };
    }
    return this.request("POST", "/oms/note", payload);
  }
}

type Factory = (deps: OmsClientDeps) => OmsClient;
let factoryOverride: Factory | null = null;

export function setOmsClientFactory(factory: Factory | null): void {
  factoryOverride = factory;
}

export function createOmsClient(deps: OmsClientDeps): OmsClient {
  return factoryOverride ? factoryOverride(deps) : new OmsClient(deps);
}

/** HMAC verification for the OMS → engine webhook (same trusted receive path as Meta). */
export function verifyOmsWebhookSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(Buffer.from(rawBody, "utf8")).digest("hex");
  return timingSafeEqual(expected, signature.replace(/^sha256=/, ""));
}
