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
  /** Per-attempt timeout ms (default 15000, env OMS_REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** GET retry budget (default 3 attempts total). POSTs never retry on answers. */
  maxGetAttempts?: number;
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

  constructor(deps: OmsClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = resolveTimeoutMs(deps.timeoutMs);
    this.maxGetAttempts = Math.max(1, deps.maxGetAttempts ?? 3);
  }

  private async fetchOnce(method: string, path: string, body?: unknown): Promise<Response> {
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
              },
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: controller.signal,
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const isWrite = method !== "GET";
    const attempts = isWrite ? 1 : this.maxGetAttempts;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchOnce(method, path, body);
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
