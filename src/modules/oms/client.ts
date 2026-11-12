import { AppError } from "@/core/errors";

/**
 * عميل باب الـ OMS `/api/v1` — الطريق الوحيد للطلبات من الردود للـ OMS.
 *
 * العقد الحي بريبو الـ OMS (`MKory18/Zaki-ai-CRM`): `src/app/api/v1/*` و
 * `src/lib/v1/*` — والمواصفة هون بـ `docs/OMS-DOOR-V1.md`.
 *
 * - كل نداء محدود بمهلة (ولا نداء معلّق).
 * - القراءة (GET) بتعيد عند الانقطاع/429/5xx.
 * - الإنشاء (POST) ما بيعيد هون أبدًا — اللي فوقه بيقرّر، وبنفس
 *   `Idempotency-Key`، فالـ OMS بينشئ طلب واحد بس.
 * - رفض نهائي من الـ OMS (422 · 404 · 409) = `OMS_REJECTED` مع رمز الـ OMS
 *   (رمز بس — رسالة الـ OMS ما بتنكتب، وما فيها قيم الزبون أصلًا).
 * - ما في تسجيل لأي توكن ولا بيانات زبون.
 */

export type OmsStockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export interface OmsOffer {
  title: string;
  quantity: number;
  price: number;
  saving: number | null;
  remainingQty: number | null;
  expiresAt: string | null;
}

export interface OmsProduct {
  code: string;
  name: string;
  price: number;
  currency: string;
  stockStatus: OmsStockStatus | null;
  offers: OmsOffer[];
  complements: string[];
}

export interface OmsOrderAttribution {
  method: "AD" | "CODE" | "NONE";
  adId?: string | null;
  adSourceType?: string | null;
  /** رمز نقرة واتساب — بينفك تشفيره لحظة الإرسال بس وما بينسجّل. */
  ctwaClid?: string | null;
  refCode?: string | null;
  refCodeAt?: string | null;
  touchAt?: string | null;
  pageId?: string | null;
  psid?: string | null;
  wabaId?: string | null;
  conversationRef?: string | null;
}

export interface OmsOrderPayload {
  idempotencyKey: string;
  orderNumber: string;
  channel: string | null;
  customer: { name: string; phone: string; city: string | null; address: string | null };
  items: Array<{ code: string; name: string; quantity: number; unitPrice: number; lineTotal: number }>;
  totals: { subtotal: number; discount: number; deliveryFee: number; total: number; currency: string };
  notes: string | null;
  attribution: OmsOrderAttribution | null;
}

export interface OmsCreatedOrder {
  id: string;
  orderNumber: string | null;
  status: string;
  /** الـ OMS سعّر من كتالوجه وطلع غير اللي بعتناه. */
  priceAdjusted: boolean;
  total: number | null;
  currency: string | null;
}

export interface OmsClientDeps {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** مهلة كل محاولة (افتراضي 15000 · `OMS_REQUEST_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** محاولات القراءة (افتراضي 3). الإنشاء محاولة وحدة دايمًا. */
  maxGetAttempts?: number;
}

/** حد صفحة المنتجات بباب الـ OMS (`readLimit(…, 100, 500)`). */
export const OMS_PRODUCTS_PAGE_LIMIT = 500;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

function stockOf(v: unknown): OmsStockStatus | null {
  return v === "IN_STOCK" || v === "LOW_STOCK" || v === "OUT_OF_STOCK" ? v : null;
}

/** منتج الـ OMS (مبالغ نص عشري) ← الشكل الداخلي. */
export function mapV1Product(raw: Record<string, unknown>): OmsProduct {
  const offers = Array.isArray(raw.offers) ? (raw.offers as Array<Record<string, unknown>>) : [];
  return {
    code: String(raw.code ?? "").trim(),
    name: String(raw.name ?? "").trim(),
    price: num(raw.price) ?? NaN,
    currency: String(raw.currency ?? "").trim(),
    stockStatus: stockOf(raw.stock_status),
    offers: offers
      .map((o) => ({
        title: String(o.title ?? "").trim(),
        quantity: Math.trunc(num(o.quantity) ?? 0),
        price: num(o.price) ?? 0,
        saving: num(o.saving),
        remainingQty: num(o.remaining_qty),
        expiresAt: o.expires_at ? String(o.expires_at) : null,
      }))
      // عرض ناقص ما بيوصل للبيع (نفس شروط `productOfferSchema`).
      .filter((o) => o.title && o.quantity >= 1 && o.price > 0),
    complements: Array.isArray(raw.complements) ? (raw.complements as unknown[]).map(String) : [],
  };
}

/** مبلغ كنص عشري بخانتين — شكل الباب الثابت («15.00»). */
export function money2(n: number): string {
  const cents = Math.round(n * 100);
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** الشكل الداخلي ← جسم `POST /api/v1/orders` (`v1OrderSchema` بالـ OMS). */
export function toV1OrderBody(p: OmsOrderPayload): Record<string, unknown> {
  const a = p.attribution;
  return {
    external_ref: p.orderNumber,
    source: "replies",
    channel: p.channel,
    customer: { name: p.customer.name, phone: p.customer.phone, city: p.customer.city, address: p.customer.address },
    items: p.items.map((i) => ({
      product_code: i.code,
      name: i.name,
      quantity: i.quantity,
      unit_price: money2(i.unitPrice),
      line_total: money2(i.lineTotal),
    })),
    totals: {
      subtotal: money2(p.totals.subtotal),
      discount: money2(p.totals.discount),
      delivery_fee: money2(p.totals.deliveryFee),
      total: money2(p.totals.total),
      currency: p.totals.currency,
    },
    notes: p.notes,
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

/** رمز الخطأ من ظرف الباب `{"error":{"code"}}` — رمز بس، بلا رسالة. */
async function omsErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? code : `HTTP_${res.status}`;
  } catch {
    return `HTTP_${res.status}`;
  }
}

export class OmsClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxGetAttempts: number;

  constructor(deps: OmsClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = resolveTimeoutMs(deps.timeoutMs);
    this.maxGetAttempts = Math.max(1, deps.maxGetAttempts ?? 3);
  }

  private async fetchOnce(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // سباق مع مهلة كمان: fetch بيتجاهل الإلغاء ما بيقدر يعلّقنا.
    const timeoutGuard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AppError("OMS request timed out", 502, "OMS_TIMEOUT"));
      }, this.timeoutMs);
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
              // رابط بيحوّل = مكان تاني — التوكن وبيانات الزبون ما بيلحقوه.
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
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private static transient(status: number): boolean {
    return status === 429 || status === 408 || status === 425 || status >= 500;
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const attempts = method === "GET" ? this.maxGetAttempts : 1;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchOnce(method, path, body, extraHeaders);
      } catch (err) {
        lastErr = err;
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, Math.min(300 * 2 ** (attempt - 1), 3000)));
          continue;
        }
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        throw new AppError(`OMS token rejected (${await omsErrorCode(res)})`, 502, "OMS_AUTH_FAILED");
      }
      if (res.status >= 300 && res.status < 400) {
        throw new AppError("OMS redirected the request (refused)", 502, "OMS_REDIRECT_REFUSED");
      }
      if (!res.ok) {
        if (OmsClient.transient(res.status)) {
          if (attempt < attempts) {
            await new Promise((r) => setTimeout(r, Math.min(300 * 2 ** (attempt - 1), 3000)));
            continue;
          }
          throw new AppError(`OMS error ${res.status}`, 502, "OMS_ERROR");
        }
        // 400 · 404 · 409 · 422: جواب نهائي — الإعادة ما بتغيّره.
        throw new AppError(`OMS refused: ${await omsErrorCode(res)}`, 422, "OMS_REJECTED");
      }
      return (await res.json()) as T;
    }
    throw lastErr instanceof AppError ? lastErr : new AppError("OMS unreachable", 502, "OMS_UNREACHABLE");
  }

  /** المنتجات الفعّالة بالـ OMS (سعر · عروض · حالة مخزون). `null` = شكل غلط. */
  async getProducts(limit = OMS_PRODUCTS_PAGE_LIMIT): Promise<OmsProduct[] | null> {
    const res = await this.request<{ items?: unknown }>("GET", `/api/v1/products?for=replies&limit=${limit}`);
    return Array.isArray(res?.items) ? (res.items as Array<Record<string, unknown>>).map(mapV1Product) : null;
  }

  async getOrder(omsOrderId: string): Promise<{ id: string; orderNumber: string | null; status: string; shippingStatus: string | null }> {
    const res = await this.request<Record<string, unknown>>("GET", `/api/v1/orders/${encodeURIComponent(omsOrderId)}`);
    return {
      id: String(res.order_id ?? omsOrderId),
      orderNumber: res.order_number ? String(res.order_number) : null,
      status: String(res.status ?? ""),
      shippingStatus: res.shipping_status ? String(res.shipping_status) : null,
    };
  }

  /** إنشاء طلب — الـ OMS بيمنع التكرار على `Idempotency-Key`. */
  async createOrder(payload: OmsOrderPayload): Promise<OmsCreatedOrder> {
    const res = await this.request<Record<string, unknown>>("POST", "/api/v1/orders", toV1OrderBody(payload), {
      "idempotency-key": payload.idempotencyKey,
      "x-request-id": `rep_${payload.orderNumber}`.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 80),
    });
    const id = res?.order_id ? String(res.order_id) : "";
    if (!id) throw new AppError("OMS returned no order id", 502, "OMS_BAD_RESPONSE");
    const totals = (res.totals ?? null) as Record<string, unknown> | null;
    return {
      id,
      orderNumber: res.order_number ? String(res.order_number) : null,
      status: String(res.status ?? "NEW"),
      priceAdjusted: res.price_adjusted === true,
      total: totals ? num(totals.total) : null,
      currency: totals?.currency ? String(totals.currency) : null,
    };
  }
}

type Factory = (deps: OmsClientDeps) => OmsClient;
let factoryOverride: Factory | null = null;

/** للاختبارات فقط: عميل بديل (الاختبارات ما بتلمس الشبكة). */
export function setOmsClientFactory(factory: Factory | null): void {
  factoryOverride = factory;
}

export function createOmsClient(deps: OmsClientDeps): OmsClient {
  return factoryOverride ? factoryOverride(deps) : new OmsClient(deps);
}
