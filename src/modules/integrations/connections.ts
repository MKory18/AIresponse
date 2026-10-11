import type { Prisma } from "@prisma/client";
import { AppError } from "@/core/errors";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import { recordAudit } from "@/modules/audit/service";
import { assertHermesEndpointResolves, validateHermesEndpoint } from "@/modules/ai/endpoint-guard";
import type { ActorContext, Db } from "@/modules/customers/service";
import { GENERIC_SYSTEMS, SYSTEM_SPECS, type GenericSystem } from "./systems";
import { newSigningSecret } from "./signing";

/**
 * P12 — اتصالات سيستم 7 بأنظمة المنظومة (غير الـ OMS الذي له جدوله).
 *
 * التوكن والسر يُشفّران فور الاستلام ولا يرجعان لأي شاشة: الواجهة ترى
 * «موجود/غير موجود» فقط. حقل فارغ عند الحفظ = لا تغيير (لا مسح بالخطأ)،
 * والمسح يكون صريحًا (clearToken / clearEventsSecret).
 */

export interface DecryptedConnection {
  id: string;
  workspaceId: string;
  system: GenericSystem;
  baseUrl: string | null;
  token: string | null;
  eventsUrl: string | null;
  eventsSecret: string | null;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface ConnectionView {
  system: GenericSystem;
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  eventsUrl: string | null;
  effectiveEventsUrl: string | null;
  hasToken: boolean;
  hasEventsSecret: boolean;
  settings: Record<string, unknown>;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

type ConnRow = {
  id: string;
  workspaceId: string;
  system: string;
  baseUrl: string | null;
  tokenEncrypted: string | null;
  eventsUrl: string | null;
  eventsSecretEncrypted: string | null;
  enabled: boolean;
  settings: unknown;
  lastOkAt: Date | string | null;
  lastErrorAt: Date | string | null;
  lastError: string | null;
};

function privateNetworkAllowed(): boolean {
  return ["1", "true", "yes"].includes((process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORK ?? "").toLowerCase());
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h.includes(":")) return h === "::1"; // IPv6: الحلقة المحلية فقط — ULA/link-local تبقى للحارس الصارم
  return (
    h === "localhost" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^[a-z0-9-]+$/.test(h) // اسم خدمة داخل شبكة docker بلا نقطة (zaki-bridge)
  );
}

/**
 * رابط نظام: http(s) بلا بيانات دخول بالرابط، وبلا عناوين البيانات الوصفية
 * للسحابة. الشبكة الخاصة (localhost · RFC1918 · اسم خدمة docker) مسموحة فقط
 * إذا فعّلها المشغّل من بيئة الخادم INTEGRATIONS_ALLOW_PRIVATE_NETWORK.
 * أي رابط عام لازم يكون https.
 */
export function validateSystemUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }
  const allowPrivate = privateNetworkAllowed();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateHost = isPrivateHost(host);
  if (privateHost && !allowPrivate) return { ok: false, reason: "PRIVATE_NETWORK_NOT_ALLOWED" };
  if (!privateHost && url.protocol !== "https:") return { ok: false, reason: "HTTPS_REQUIRED" };
  if (url.username || url.password) return { ok: false, reason: "CREDENTIALS_IN_URL" };
  // اسم خدمة docker بلا نقطة: الحارس الصارم يقبله كاسم، ونقبله هنا فقط تحت العلم.
  if (privateHost && /^[a-z0-9-]+$/i.test(host) && host.toLowerCase() !== "localhost") return { ok: true, url: value };
  const verdict = validateHermesEndpoint(value, { allowPrivateNetwork: allowPrivate });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, url: value };
}

type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;
let lookupOverride: LookupFn | null = null;

/** للاختبارات فقط: محلّل DNS بديل (الاختبارات لا تلمس الشبكة). */
export function setIntegrationDnsLookup(fn: LookupFn | null): void {
  lookupOverride = fn;
}

/**
 * فحص رابط نظام مع DNS — عند الحفظ وعند كل إرسال/قراءة: اسم انحفظ سليم
 * وبعدين صار يشير لعنوان داخلي (DNS rebinding) بينرفض لحظتها.
 * transient = فشل حلّ مؤقت (يُعاد لاحقًا) لا رفض أمني.
 */
export async function checkSystemUrl(raw: string): Promise<{ ok: true; url: string } | { ok: false; reason: string; transient: boolean }> {
  const sync = validateSystemUrl(raw);
  if (!sync.ok) return { ok: false, reason: sync.reason, transient: false };
  const host = new URL(sync.url).hostname.replace(/^\[|\]$/g, "");
  // الحرفيات (localhost · IP) مصنّفة أعلاه؛ أي اسم آخر — حتى اسم خدمة docker —
  // يُحلّ DNS ويُرفض إذا أشار لعنوان محجوب (بيانات السحابة الوصفية مثلًا).
  if (host === "localhost" || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: true, url: sync.url };
  const dns = await assertHermesEndpointResolves(sync.url, {
    allowPrivateNetwork: privateNetworkAllowed(),
    ...(lookupOverride ? { lookupFn: lookupOverride } : {}),
  });
  if (!dns.ok) return { ok: false, reason: dns.reason, transient: dns.reason === "DNS_RESOLUTION_FAILED" };
  return { ok: true, url: sync.url };
}

async function validateUrlWithDns(raw: string): Promise<string> {
  const r = await checkSystemUrl(raw);
  if (!r.ok) throw new AppError(`رابط النظام غير مقبول (${r.reason})`, 422, "INVALID_SYSTEM_URL");
  return r.url;
}

function toIso(v: Date | string | null): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asSettings(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** رابط استقبال الأحداث الفعلي: eventsUrl صريح أو baseUrl + مسار العقد. */
export function effectiveEventsUrl(system: GenericSystem, baseUrl: string | null, eventsUrl: string | null): string | null {
  if (eventsUrl) return eventsUrl;
  const path = SYSTEM_SPECS[system].eventsPath;
  if (!baseUrl || !path) return null;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function toConnectionView(system: GenericSystem, row: ConnRow | null): ConnectionView {
  if (!row) {
    return {
      system,
      configured: false,
      enabled: false,
      baseUrl: null,
      eventsUrl: null,
      effectiveEventsUrl: null,
      hasToken: false,
      hasEventsSecret: false,
      settings: {},
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
    };
  }
  return {
    system,
    configured: Boolean(row.baseUrl || row.eventsUrl),
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    eventsUrl: row.eventsUrl,
    effectiveEventsUrl: effectiveEventsUrl(system, row.baseUrl, row.eventsUrl),
    hasToken: Boolean(row.tokenEncrypted),
    hasEventsSecret: Boolean(row.eventsSecretEncrypted),
    settings: asSettings(row.settings),
    lastOkAt: toIso(row.lastOkAt),
    lastErrorAt: toIso(row.lastErrorAt),
    lastError: row.lastError,
  };
}

async function findRow(db: Db, workspaceId: string, system: GenericSystem): Promise<ConnRow | null> {
  const model = (db as unknown as { integrationConnection?: { findUnique: (a: unknown) => Promise<unknown> } }).integrationConnection;
  if (!model) return null;
  return (await model.findUnique({ where: { workspaceId_system: { workspaceId, system } } })) as ConnRow | null;
}

/** الاتصال مفكوك التشفير — للاستخدام داخل الخادم فقط (العامل والعملاء). */
export async function getDecryptedConnection(db: Db, workspaceId: string, system: GenericSystem): Promise<DecryptedConnection | null> {
  const row = await findRow(db, workspaceId, system);
  if (!row) return null;
  let token: string | null = null;
  let eventsSecret: string | null = null;
  try {
    token = row.tokenEncrypted ? decryptSecret(row.tokenEncrypted) : null;
    eventsSecret = row.eventsSecretEncrypted ? decryptSecret(row.eventsSecretEncrypted) : null;
  } catch {
    // سر غير قابل للقراءة (تغيّر مفتاح التشفير): الاتصال كأنه غير مضبوط —
    // ولا نرسل أبدًا بلا توقيع.
    return null;
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    system,
    baseUrl: row.baseUrl,
    token,
    eventsUrl: row.eventsUrl,
    eventsSecret,
    enabled: row.enabled,
    settings: asSettings(row.settings),
  };
}

export interface SaveConnectionInput {
  baseUrl?: string | null;
  token?: string | null;
  eventsUrl?: string | null;
  eventsSecret?: string | null;
  generateEventsSecret?: boolean;
  clearToken?: boolean;
  clearEventsSecret?: boolean;
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

export async function saveIntegrationConnection(
  db: Db,
  ctx: ActorContext,
  system: GenericSystem,
  input: SaveConnectionInput
): Promise<{ view: ConnectionView; generatedEventsSecret: string | null }> {
  if (!GENERIC_SYSTEMS.includes(system)) throw new AppError("نظام غير معروف", 404, "UNKNOWN_SYSTEM");
  const existing = await findRow(db, ctx.workspaceId, system);

  const data: Record<string, unknown> = {};
  if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl ? await validateUrlWithDns(input.baseUrl) : null;
  if (input.eventsUrl !== undefined) data.eventsUrl = input.eventsUrl ? await validateUrlWithDns(input.eventsUrl) : null;
  if (input.clearToken) data.tokenEncrypted = null;
  else if (input.token) data.tokenEncrypted = encryptSecret(input.token.trim());
  let generatedEventsSecret: string | null = null;
  if (input.clearEventsSecret) data.eventsSecretEncrypted = null;
  else if (input.generateEventsSecret) {
    generatedEventsSecret = newSigningSecret();
    data.eventsSecretEncrypted = encryptSecret(generatedEventsSecret);
  } else if (input.eventsSecret) data.eventsSecretEncrypted = encryptSecret(input.eventsSecret.trim());
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.settings !== undefined) data.settings = { ...asSettings(existing?.settings), ...input.settings } as Prisma.InputJsonValue;

  const model = (db as unknown as { integrationConnection: { upsert: (a: unknown) => Promise<unknown> } }).integrationConnection;
  const row = (await model.upsert({
    where: { workspaceId_system: { workspaceId: ctx.workspaceId, system } },
    create: { workspaceId: ctx.workspaceId, system, enabled: input.enabled ?? true, ...data },
    update: data,
  })) as ConnRow;

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "integration.connection_saved",
    entityType: "IntegrationConnection",
    entityId: row.id,
    // لا أسرار في السجل: أسماء الحقول التي تغيّرت فقط.
    metadata: {
      system,
      changed: Object.keys(data).map((k) => (k.endsWith("Encrypted") ? k.replace("Encrypted", "") : k)),
    },
  });
  return { view: toConnectionView(system, row), generatedEventsSecret };
}

/** نتيجة آخر نداء/حدث — تظهر بصفحة الربط (لا تفشل العملية الأصلية أبدًا). */
export async function markConnectionResult(
  db: Db,
  workspaceId: string,
  system: GenericSystem,
  result: { ok: true } | { ok: false; error: string }
): Promise<void> {
  try {
    const model = (db as unknown as { integrationConnection?: { updateMany: (a: unknown) => Promise<unknown> } }).integrationConnection;
    if (!model) return;
    await model.updateMany({
      where: { workspaceId, system },
      data: result.ok
        ? { lastOkAt: new Date() }
        : { lastErrorAt: new Date(), lastError: result.error.slice(0, 300) },
    });
  } catch {
    /* observability only */
  }
}

export async function listConnectionViews(db: Db, workspaceId: string): Promise<ConnectionView[]> {
  const model = (db as unknown as { integrationConnection?: { findMany: (a: unknown) => Promise<unknown> } }).integrationConnection;
  const rows = model ? ((await model.findMany({ where: { workspaceId } })) as ConnRow[]) : [];
  return GENERIC_SYSTEMS.map((system) => toConnectionView(system, rows.find((r) => r.system === system) ?? null));
}
