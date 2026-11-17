/**
 * نداء الـAPI الموحّد للواجهة (2.1، 03-UI-STRUCTURE §6.2): دالة وحدة بدل 3 نسخ متطابقة.
 * الأخطاء بتتحوّل لعربي من خريطة رموز وحدة — ولا طلب بيفشل بصمت، و`403` دايمًا نفس الجملة.
 */

export const API_ERROR_MESSAGES: Record<string, string> = {
  AUTHENTICATION_ERROR: "انتهت الجلسة — سجّل الدخول من جديد",
  AUTHORIZATION_ERROR: "ما عندك صلاحية لهذا الإجراء",
  CANNOT_GRANT: "ما بتقدر تمنح صلاحية ما عندك مثلها",
  PERMISSION_NOT_GRANTABLE: "هذه الصلاحية بتنعطى لشريك أو مالك بس",
  MEMBER_INVITES_DISABLED: "دعوة الحسابات المسجّلة متوقفة — أنشئ الحساب مباشرة",
  VALIDATION_ERROR: "في بيانات ناقصة أو غير صحيحة",
  RATE_LIMITED: "طلبات كتير بوقت قصير — جرّب بعد شوي",
  PAYLOAD_TOO_LARGE: "الحجم أكبر من المسموح",
  NOT_FOUND: "ما لقينا المطلوب",
  INTERNAL_ERROR: "صار خطأ عندنا — جرّب مرة ثانية",
};

export const FORBIDDEN_MESSAGE = "ما عندك صلاحية لهذا الإجراء";
export const NETWORK_MESSAGE = "تعذّر الاتصال بالخادم";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** رسالة عربية لخطأ: رمز معروف ← من الخريطة · 403 ← الجملة الثابتة · غير هيك رسالة الخادم · وإلا عامة. */
export function messageForError(status: number, body: { error?: string; message?: string } | null): string {
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 401) return API_ERROR_MESSAGES.AUTHENTICATION_ERROR!;
  const code = body?.error;
  if (code && API_ERROR_MESSAGES[code]) return API_ERROR_MESSAGES[code]!;
  if (body?.message && /[؀-ۿ]/.test(body.message)) return body.message;
  if (status >= 500) return API_ERROR_MESSAGES.INTERNAL_ERROR!;
  return "فشل الطلب";
}

export interface ApiOptions extends Omit<RequestInit, "body"> {
  /** جسم JSON — بيتحوّل ويتحط له `Content-Type`. */
  json?: unknown;
  /** بدائل للاختبار. */
  fetcher?: typeof fetch;
}

/** نداء JSON: بيرجّع البيانات أو بيرمي `ApiError` برسالة عربية مفهومة. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { json, fetcher, headers, ...rest } = options;
  const doFetch = fetcher ?? fetch;
  let res: Response;
  try {
    res = await doFetch(path, {
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(headers ?? {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch {
    throw new ApiError(NETWORK_MESSAGE, 0, "NETWORK_ERROR");
  }
  const body = (await res.json().catch(() => null)) as ({ error?: string; message?: string; details?: unknown } & Record<string, unknown>) | null;
  if (!res.ok) throw new ApiError(messageForError(res.status, body), res.status, body?.error ?? null, body?.details);
  return body as T;
}
