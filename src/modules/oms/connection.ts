import { AppError } from "@/core/errors";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { checkSystemUrl } from "@/modules/integrations/connections";
import { createOmsClient, type OmsClient } from "./client";

/**
 * اتصال الـ OMS لكل مساحة: الرابط + توكن «توكنات الأنظمة» من الـ OMS
 * (`zk1_…`) + هل كل طلب بينبعت تلقائيًا.
 *
 * التوكن بيتشفّر فور الاستلام وما بيرجع للواجهة أبدًا (`hasToken` بس).
 * الرابط بينفحص (https + DNS) عند الحفظ وعند كل نداء: اسم صار يشير لعنوان
 * داخلي بينرفض قبل ما يطلع التوكن.
 */

type OmsConnRow = {
  id: string;
  workspaceId: string;
  baseUrl: string;
  tokenEncrypted: string;
  isActive: boolean;
  autoHandoff: boolean;
  lastProductSyncAt: Date | string | null;
  lastOkAt?: Date | string | null;
  lastErrorAt: Date | string | null;
  lastError: string | null;
};

export interface OmsConnectionView {
  configured: boolean;
  baseUrl: string | null;
  isActive: boolean;
  autoHandoff: boolean;
  hasToken: boolean;
  lastProductSyncAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

function model(db: Db) {
  return (db as unknown as {
    omsConnection: {
      findUnique: (a: unknown) => Promise<unknown>;
      upsert: (a: unknown) => Promise<unknown>;
      update: (a: unknown) => Promise<unknown>;
    };
  }).omsConnection;
}

function hasRealToken(enc: string | null | undefined): boolean {
  if (!enc) return false;
  try {
    return decryptSecret(enc).length > 0;
  } catch {
    return false;
  }
}

export function toOmsConnectionView(row: OmsConnRow | null): OmsConnectionView {
  return {
    configured: Boolean(row),
    baseUrl: row?.baseUrl ?? null,
    isActive: row?.isActive ?? false,
    autoHandoff: row?.autoHandoff ?? false,
    hasToken: hasRealToken(row?.tokenEncrypted),
    lastProductSyncAt: iso(row?.lastProductSyncAt),
    lastOkAt: iso(row?.lastOkAt),
    lastErrorAt: iso(row?.lastErrorAt),
    lastError: row?.lastError ?? null,
  };
}

export async function getOmsConnectionRow(db: Db, workspaceId: string): Promise<OmsConnRow | null> {
  return ((await model(db).findUnique({ where: { workspaceId } })) as OmsConnRow | null) ?? null;
}

export async function getOmsConnectionView(db: Db, workspaceId: string): Promise<OmsConnectionView> {
  return toOmsConnectionView(await getOmsConnectionRow(db, workspaceId));
}

/** آخر خطأ (رمز بس — لا توكن ولا بيانات زبون). ما بيكسر شي إذا فشل. */
export async function noteOmsError(db: Db, workspaceId: string, code: string): Promise<void> {
  await model(db)
    .update({ where: { workspaceId }, data: { lastErrorAt: new Date(), lastError: code.slice(0, 120) } })
    .catch(() => undefined);
}

export async function noteOmsOk(db: Db, workspaceId: string): Promise<void> {
  await model(db)
    .update({ where: { workspaceId }, data: { lastOkAt: new Date() } })
    .catch(() => undefined);
}

export interface SaveOmsConnectionInput {
  baseUrl: string;
  token?: string | null;
  isActive?: boolean;
  autoHandoff?: boolean;
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
  const existing = await getOmsConnectionRow(db, ctx.workspaceId);
  const token = input.token?.trim() || null;
  if (!token && !hasRealToken(existing?.tokenEncrypted)) {
    throw new AppError("لازم توكن الـ OMS (من «توكنات الأنظمة» بالـ OMS)", 422, "OMS_TOKEN_REQUIRED");
  }
  const data: Record<string, unknown> = {
    baseUrl: url.url,
    mode: "api",
    apiVersion: "v1",
    isActive: input.isActive ?? existing?.isActive ?? true,
    // قرار المالك: كل طلب بينزل بالـ OMS — مفعّل من أول حفظ، وبينطفى من الواجهة.
    autoHandoff: input.autoHandoff ?? existing?.autoHandoff ?? true,
  };
  if (token) data.tokenEncrypted = encryptSecret(token);

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
    // بلا أسرار: الرابط والإعدادات ووجود تغيير بالتوكن بس.
    metadata: { baseUrl: url.url, isActive: data.isActive, autoHandoff: data.autoHandoff, tokenChanged: Boolean(token) },
  });
  return toOmsConnectionView(row);
}

/**
 * عميل الـ OMS للمساحة من الاتصال المحفوظ — بعد فحص الرابط (https + DNS).
 * رابط مرفوض = `OMS_URL_REJECTED` قبل ما يطلع التوكن.
 */
export async function buildOmsClient(db: Db, workspaceId: string): Promise<OmsClient> {
  const conn = await getOmsConnectionRow(db, workspaceId);
  if (!conn || !conn.isActive) throw new AppError("الـ OMS مش مربوط", 422, "OMS_NOT_CONFIGURED");
  if (!hasRealToken(conn.tokenEncrypted)) throw new AppError("توكن الـ OMS ناقص", 422, "OMS_NOT_CONFIGURED");
  const check = await checkSystemUrl(conn.baseUrl);
  if (!check.ok) {
    if (check.transient) throw new AppError("تعذر الوصول لاسم الـ OMS (DNS)", 503, "OMS_UNREACHABLE");
    throw new AppError(`رابط الـ OMS مرفوض (${check.reason})`, 422, "OMS_URL_REJECTED");
  }
  return createOmsClient({ baseUrl: conn.baseUrl, token: decryptSecret(conn.tokenEncrypted) });
}

export interface OmsProbeResult {
  ok: boolean;
  detail: string;
  products: number | null;
}

/** «اختبر الاتصال»: قراءة منتج واحد من الباب بالتوكن المحفوظ. */
export async function probeOmsConnection(db: Db, workspaceId: string): Promise<OmsProbeResult> {
  let client: OmsClient;
  try {
    client = await buildOmsClient(db, workspaceId);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "الـ OMS مش مربوط", products: null };
  }
  try {
    const items = await client.getProducts(1);
    if (!items) {
      await noteOmsError(db, workspaceId, "probe: OMS_BAD_RESPONSE");
      return { ok: false, detail: "الـ OMS رد بشكل غير متوقع — تأكد إن الرابط هو رابط الـ OMS نفسه", products: null };
    }
    await noteOmsOk(db, workspaceId);
    return { ok: true, detail: "الباب شغّال والتوكن مقبول", products: items.length };
  } catch (err) {
    const code = err instanceof AppError ? err.code : "ERROR";
    await noteOmsError(db, workspaceId, `probe: ${code}`);
    const detail =
      code === "OMS_AUTH_FAILED"
        ? "الـ OMS رفض التوكن — تأكد إنه شغّال وفيه صلاحية products.read"
        : code === "OMS_REJECTED"
          ? "الـ OMS رد بخطأ — تأكد إن الرابط هو رابط الـ OMS نفسه"
          : code === "OMS_TIMEOUT" || code === "OMS_UNREACHABLE"
            ? "الـ OMS ما رد على الرابط"
            : "تعذر فحص الباب";
    return { ok: false, detail, products: null };
  }
}
