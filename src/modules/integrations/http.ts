import { checkSystemUrl, type DecryptedConnection } from "./connections";
import { newRequestId } from "./signing";

/**
 * P12 — قراءة متزامنة من نظام آخر (رمز الكليبر · قواعد سيستم 1).
 * مهلة قصيرة · توكن الاتصال · لا تتبع للتحويلات · X-Request-Id.
 * الكتابة لا تمر من هنا أبدًا — كل كتابة عبر صندوق الصادر (outbox).
 */

export interface SystemGetResult {
  ok: boolean;
  status: number | null;
  json: unknown;
  error?: "URL_REJECTED" | "TIMEOUT" | "NETWORK_ERROR" | "NOT_CONFIGURED" | "BAD_JSON";
}

let fetchOverride: typeof fetch | null = null;

/** للاختبارات فقط: بديل fetch لقراءات الأنظمة (لا شبكة بالاختبارات). */
export function setSystemFetch(fn: typeof fetch | null): void {
  fetchOverride = fn;
}

export async function systemGet(conn: DecryptedConnection | null, path: string, timeoutMs = 5000): Promise<SystemGetResult> {
  if (!conn || !conn.enabled || !conn.baseUrl) return { ok: false, status: null, json: null, error: "NOT_CONFIGURED" };
  const url = `${conn.baseUrl.replace(/\/+$/, "")}${path}`;
  const check = await checkSystemUrl(url);
  if (!check.ok) return { ok: false, status: null, json: null, error: check.transient ? "NETWORK_ERROR" : "URL_REJECTED" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json", "x-request-id": newRequestId(), "user-agent": "zaki-replies/1.0" };
    if (conn.token) headers.authorization = `Bearer ${conn.token}`;
    const res = await (fetchOverride ?? fetch)(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      if (res.ok) return { ok: false, status: res.status, json: null, error: "BAD_JSON" };
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: null, json: null, error: err instanceof Error && err.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR" };
  } finally {
    clearTimeout(timer);
  }
}
