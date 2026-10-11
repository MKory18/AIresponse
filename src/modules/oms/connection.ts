import crypto from "node:crypto";
import { AppError } from "@/core/errors";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { checkSystemUrl } from "@/modules/integrations/connections";
import { OMS_APP_EVENTS } from "./app-webhook";

/**
 * P12 — اتصال الـ OMS الكامل: وضع الترحيل (api/manual) · لهجة الـ API ·
 * سر توقيع أحداث التطبيقات (zk_…) · مفتاح مسار الاستقبال · الترحيل التلقائي.
 *
 * التوكن والسر يُشفّران فور الاستلام ولا يرجعان أبدًا. الوضع اليدوي لا يحتاج
 * توكن API (الـ OMS بلا باب استقبال بعد) — يُحفظ بديل مشفّر معروف لا يصلح
 * لأي نداء، والتبديل لوضع api يشترط توكنًا حقيقيًا.
 */

export const OMS_NO_TOKEN = "__oms_no_token__";

type OmsConnRow = {
  id: string;
  workspaceId: string;
  baseUrl: string;
  tokenEncrypted: string;
  isActive: boolean;
  lastProductSyncAt: Date | string | null;
  lastCustomerSyncAt: Date | string | null;
  mode: string;
  apiVersion: string;
  webhookSecretEncrypted: string | null;
  webhookKey: string | null;
  autoHandoff: boolean;
  lastWebhookAt: Date | string | null;
  lastOkAt: Date | string | null;
  lastErrorAt: Date | string | null;
  lastError: string | null;
};

export interface OmsConnectionView {
  configured: boolean;
  baseUrl: string | null;
  isActive: boolean;
  mode: "api" | "manual";
  apiVersion: "legacy" | "v1";
  autoHandoff: boolean;
  hasToken: boolean;
  hasWebhookSecret: boolean;
  webhookPath: string | null;
  webhookUrl: string | null;
  events: readonly string[];
  lastWebhookAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastProductSyncAt: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

function hasRealToken(enc: string | null | undefined): boolean {
  if (!enc) return false;
  try {
    const v = decryptSecret(enc);
    return v.length > 0 && v !== OMS_NO_TOKEN;
  } catch {
    return false;
  }
}

function appUrl(): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export function toOmsConnectionView(row: OmsConnRow | null): OmsConnectionView {
  const path = row?.webhookKey ? `/api/webhooks/oms/${row.webhookKey}` : null;
  const base = appUrl();
  return {
    configured: Boolean(row),
    baseUrl: row?.baseUrl ?? null,
    isActive: row?.isActive ?? false,
    mode: row?.mode === "manual" ? "manual" : "api",
    apiVersion: row?.apiVersion === "v1" ? "v1" : "legacy",
    autoHandoff: row?.autoHandoff ?? false,
    hasToken: hasRealToken(row?.tokenEncrypted),
    hasWebhookSecret: Boolean(row?.webhookSecretEncrypted),
    webhookPath: path,
    webhookUrl: path && base ? `${base}${path}` : null,
    events: OMS_APP_EVENTS,
    lastWebhookAt: iso(row?.lastWebhookAt),
    lastOkAt: iso(row?.lastOkAt),
    lastErrorAt: iso(row?.lastErrorAt),
    lastError: row?.lastError ?? null,
    lastProductSyncAt: iso(row?.lastProductSyncAt),
  };
}

function model(db: Db) {
  return (db as unknown as {
    omsConnection: {
      findUnique: (a: unknown) => Promise<unknown>;
      upsert: (a: unknown) => Promise<unknown>;
      update: (a: unknown) => Promise<unknown>;
    };
  }).omsConnection;
}

export async function getOmsConnectionView(db: Db, workspaceId: string): Promise<OmsConnectionView> {
  const row = (await model(db).findUnique({ where: { workspaceId } })) as OmsConnRow | null;
  return toOmsConnectionView(row);
}

export interface SaveOmsConnectionInput {
  baseUrl: string;
  token?: string | null;
  isActive?: boolean;
  mode?: "api" | "manual";
  apiVersion?: "legacy" | "v1";
  webhookSecret?: string | null;
  autoHandoff?: boolean;
  rotateWebhookKey?: boolean;
}

function newWebhookKey(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export async function saveOmsConnection(db: Db, ctx: ActorContext, input: SaveOmsConnectionInput): Promise<OmsConnectionView> {
  const url = await checkSystemUrl(input.baseUrl);
  if (!url.ok) {
    throw new AppError(
      url.transient ? "رابط الـ OMS ما بينحل (DNS) — تأكد من الكتابة" : `رابط الـ OMS غير مقبول (${url.reason})`,
      422,
      "INVALID_SYSTEM_URL"
    );
  }
  const existing = (await model(db).findUnique({ where: { workspaceId: ctx.workspaceId } })) as OmsConnRow | null;
  const mode = input.mode ?? (existing?.mode === "manual" ? "manual" : "api");
  const token = input.token?.trim() || null;
  if (mode === "api" && !token && !hasRealToken(existing?.tokenEncrypted)) {
    throw new AppError("وضع الـ API يحتاج توكن الـ OMS", 422, "OMS_TOKEN_REQUIRED");
  }
  if (input.autoHandoff && mode !== "api") {
    throw new AppError("الترحيل التلقائي يشتغل بوضع الـ API فقط", 422, "AUTO_HANDOFF_NEEDS_API");
  }
  const webhookSecret = input.webhookSecret?.trim() || null;
  if (webhookSecret && webhookSecret.length < 16) {
    throw new AppError("سر التوقيع قصير — انسخه كاملًا من شاشة التطبيقات بالـ OMS", 422, "WEBHOOK_SECRET_TOO_SHORT");
  }

  const data: Record<string, unknown> = {
    baseUrl: url.url,
    mode,
    apiVersion: input.apiVersion ?? (existing ? (existing.apiVersion === "v1" ? "v1" : "legacy") : "v1"),
    isActive: input.isActive ?? existing?.isActive ?? true,
    // الوضع اليدوي بيطفّي الترحيل التلقائي فعليًا (مش بس بيتجاهله) — الرجوع
    // للـ API ما بيرجّعه بصمت؛ بيتفعّل من جديد بقرار صريح.
    autoHandoff: mode === "api" ? (input.autoHandoff ?? existing?.autoHandoff ?? false) : false,
  };
  if (token) data.tokenEncrypted = encryptSecret(token);
  else if (!existing) data.tokenEncrypted = encryptSecret(OMS_NO_TOKEN);
  if (webhookSecret) data.webhookSecretEncrypted = encryptSecret(webhookSecret);
  if (!existing?.webhookKey || input.rotateWebhookKey) data.webhookKey = newWebhookKey();

  const row = (await model(db).upsert({
    where: { workspaceId: ctx.workspaceId },
    create: { workspaceId: ctx.workspaceId, ...data },
    update: data,
  })) as OmsConnRow;
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "oms.connection_saved",
    entityType: "OmsConnection",
    entityId: row.id,
    // لا أسرار: الرابط والوضع وأسماء الحقول التي تغيرت فقط.
    metadata: {
      baseUrl: url.url,
      mode,
      apiVersion: data.apiVersion,
      tokenChanged: Boolean(token),
      webhookSecretChanged: Boolean(webhookSecret),
      webhookKeyRotated: Boolean(data.webhookKey && existing?.webhookKey),
    },
  });
  return toOmsConnectionView(row);
}

export interface OmsProbeResult {
  reachable: boolean;
  status: number | null;
  doorAvailable: boolean | null;
  detail: string;
}

/**
 * فحص حي: صحة الـ OMS (/api/health) ثم — بوضع api/v1 — هل باب الاستقبال
 * موجود (404 = الباب لم يُبنَ بالـ OMS بعد، وهذا هو الوضع اليوم).
 */
export async function probeOmsConnection(db: Db, workspaceId: string, fetchImpl: typeof fetch = fetch): Promise<OmsProbeResult> {
  const row = (await model(db).findUnique({ where: { workspaceId } })) as OmsConnRow | null;
  if (!row) throw new AppError("الـ OMS غير مضبوط", 422, "OMS_NOT_CONFIGURED");
  const dns = await checkSystemUrl(row.baseUrl);
  if (!dns.ok) {
    if (dns.transient) return { reachable: false, status: null, doorAvailable: null, detail: "تعذر حل اسم الـ OMS (DNS) — جرّب كمان شوي" };
    return {
      reachable: false,
      status: null,
      doorAvailable: null,
      detail:
        dns.reason === "DNS_NOT_GLOBAL_UNICAST"
          ? "رابط الـ OMS صار يشير لعنوان داخلي محجوب — ما انبعت التوكن"
          : `رابط الـ OMS مرفوض (${dns.reason}) — ما انبعت التوكن`,
    };
  }
  const base = row.baseUrl.replace(/\/+$/, "");
  const call = async (path: string, auth: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const headers: Record<string, string> = {};
      if (auth && hasRealToken(row.tokenEncrypted)) headers.authorization = `Bearer ${decryptSecret(row.tokenEncrypted)}`;
      return await fetchImpl(`${base}${path}`, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    } finally {
      clearTimeout(timer);
    }
  };
  let health: Response;
  try {
    health = await call("/api/health", false);
  } catch {
    await model(db).update({ where: { workspaceId }, data: { lastErrorAt: new Date(), lastError: "probe: UNREACHABLE" } }).catch(() => undefined);
    return { reachable: false, status: null, doorAvailable: null, detail: "الـ OMS لا يرد على الرابط" };
  }
  if (!health.ok) {
    return { reachable: false, status: health.status, doorAvailable: null, detail: `صحة الـ OMS رجّعت ${health.status}` };
  }
  if (row.mode !== "api" || row.apiVersion !== "v1") {
    await model(db).update({ where: { workspaceId }, data: { lastOkAt: new Date() } }).catch(() => undefined);
    return { reachable: true, status: health.status, doorAvailable: null, detail: "الـ OMS شغّال" };
  }
  try {
    const door = await call("/api/v1/products?for=replies&limit=1", true);
    if (door.status === 404) {
      return { reachable: true, status: 404, doorAvailable: false, detail: "باب الاستقبال /api/v1 غير موجود بالـ OMS بعد — استخدم الوضع اليدوي" };
    }
    if (door.status === 401 || door.status === 403) {
      return { reachable: true, status: door.status, doorAvailable: true, detail: "الباب موجود لكن التوكن مرفوض" };
    }
    const ok = door.ok;
    await model(db)
      .update({ where: { workspaceId }, data: ok ? { lastOkAt: new Date() } : { lastErrorAt: new Date(), lastError: `probe: HTTP ${door.status}` } })
      .catch(() => undefined);
    return { reachable: true, status: door.status, doorAvailable: ok, detail: ok ? "الباب شغّال والتوكن مقبول" : `الباب رجّع ${door.status}` };
  } catch {
    return { reachable: true, status: null, doorAvailable: null, detail: "تعذر فحص الباب" };
  }
}
