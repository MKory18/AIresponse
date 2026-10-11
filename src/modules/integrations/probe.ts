import { AppError } from "@/core/errors";
import type { Db } from "@/modules/customers/service";
import { checkSystemUrl, effectiveEventsUrl, getDecryptedConnection, markConnectionResult } from "./connections";
import { systemGet } from "./http";
import { isGenericSystem, SYSTEM_SPECS, type GenericSystem } from "./systems";

/**
 * P12 — «اختبر الاتصال» لكل نظام من صفحة الربط: قراءة فقط، بلا أي حدث
 * حقيقي (اختبار ما بيبعت إنذار وهمي لـ Hermes ولا قيد للمالية).
 * - أنظمة Zaki: GET {base}/api/health (موجودة بكل نظام حسب العقد).
 * - الجسر: رابط الأحداث بيرد (أي رد HTTP أقل من 500 = واصل؛ الطريقة GET
 *   مش مسموحة عنده عادةً = 405 وهاد طبيعي).
 */

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  detail: string;
}

let probeFetch: typeof fetch | null = null;
/** للاختبارات فقط. */
export function setProbeFetch(fn: typeof fetch | null): void {
  probeFetch = fn;
}

export async function testIntegrationConnection(db: Db, workspaceId: string, system: string): Promise<ProbeResult> {
  if (!isGenericSystem(system)) throw new AppError("نظام غير معروف", 404, "UNKNOWN_SYSTEM");
  const sys = system as GenericSystem;
  const conn = await getDecryptedConnection(db, workspaceId, sys);
  if (!conn) return { ok: false, status: null, detail: "الاتصال مش مضبوط لسا" };
  if (!conn.enabled) return { ok: false, status: null, detail: "الاتصال موقوف" };

  let result: ProbeResult;
  if (sys === "bridge") {
    const url = effectiveEventsUrl(sys, conn.baseUrl, conn.eventsUrl);
    if (!url) return { ok: false, status: null, detail: "رابط استقبال الأحداث مش مضبوط" };
    const check = await checkSystemUrl(url);
    if (!check.ok) {
      result = { ok: false, status: null, detail: check.transient ? "الرابط ما بينحل (DNS)" : `الرابط مرفوض (${check.reason})` };
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await (probeFetch ?? fetch)(url, { method: "GET", signal: controller.signal, redirect: "manual" });
        result =
          res.status < 500
            ? { ok: true, status: res.status, detail: `الجسر بيرد (${res.status}) — الأحداث بتنبعت موقّعة بـ POST` }
            : { ok: false, status: res.status, detail: `الجسر رجّع ${res.status}` };
      } catch (err) {
        result = { ok: false, status: null, detail: err instanceof Error && err.name === "AbortError" ? "الجسر ما رد خلال 5 ثواني" : "الجسر مش واصل" };
      } finally {
        clearTimeout(timer);
      }
    }
  } else {
    const r = await systemGet(conn, "/api/health", 5000);
    if (r.ok) result = { ok: true, status: r.status, detail: `${SYSTEM_SPECS[sys].nameAr} شغّال` };
    else if (r.error === "NOT_CONFIGURED") result = { ok: false, status: null, detail: "الرابط الأساسي مش مضبوط" };
    else if (r.error === "URL_REJECTED") result = { ok: false, status: null, detail: "الرابط مرفوض (عنوان داخلي أو بلا https)" };
    else if (r.error === "TIMEOUT") result = { ok: false, status: null, detail: "ما رد خلال 5 ثواني" };
    else if (r.status) result = { ok: false, status: r.status, detail: `رجّع ${r.status}` };
    else result = { ok: false, status: null, detail: "مش واصل" };
  }
  await markConnectionResult(db, workspaceId, sys, result.ok ? { ok: true } : { ok: false, error: `test: ${result.detail}` });
  return result;
}
