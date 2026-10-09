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

export interface OmsOrderPayload {
  idempotencyKey: string;
  orderNumber: string;
  customer: { name: string; phone: string; address: string; province: string };
  items: Array<{ sku: string; name: string; unitPrice: number; quantity: number; subtotal: number }>;
  totals: { subtotal: number; discount: number; deliveryFee: number; total: number; currency: string };
  adSource?: string | null;
  notes?: string | null;
  conversationId?: string | null;
}

export interface OmsClientDeps {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * OmsClient — the ONLY outbound path to the OMS. Token scope is read + create
 * confirmed order + confirmation result + note (nothing else). Never changes
 * OMS state, prices, or fulfillment directly.
 */
export class OmsClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(deps: OmsClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new AppError("OMS unreachable", 502, "OMS_UNREACHABLE");
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError("OMS token rejected", 502, "OMS_AUTH_FAILED");
    }
    if (!res.ok) {
      throw new AppError(`OMS error ${res.status}`, 502, "OMS_ERROR");
    }
    return (await res.json()) as T;
  }

  getProducts(): Promise<{ products: OmsProduct[] }> {
    return this.request("GET", "/oms/products");
  }

  getCustomer(phone: string): Promise<OmsCustomer | null> {
    return this.request("GET", `/oms/customer?phone=${encodeURIComponent(phone)}`);
  }

  getOrder(omsOrderId: string): Promise<{ id: string; status: string; shipmentStatus?: string | null }> {
    return this.request("GET", `/oms/order/${encodeURIComponent(omsOrderId)}`);
  }

  /** Idempotent: the OMS must deduplicate on `idempotencyKey`. */
  createOrder(payload: OmsOrderPayload): Promise<{ id: string; status: string }> {
    return this.request("POST", "/oms/orders", payload);
  }

  postNote(payload: { orderId: string; kind: string; note: string }): Promise<{ ok: boolean }> {
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
