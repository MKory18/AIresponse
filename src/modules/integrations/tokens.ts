import crypto from "node:crypto";
import { AppError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { TOKEN_PRESETS, TOKEN_SCOPES, type TokenScope, type TokenSystem } from "./systems";

/**
 * P12 — توكنات الأنظمة والوكلاء الداخلة على سيستم 7 (Bearer).
 *
 * - يُحفظ SHA-256 للتوكن فقط؛ النص يُعرض مرة واحدة عند الإنشاء.
 * - صلاحيات مسماة بأقل حد لكل نظام (TOKEN_PRESETS) — لا «كل شي».
 * - صلاحية 90 يوم افتراضيًا ثم تجديد · زر إيقاف فوري (revokedAt).
 * - توكن لكل نظام: سرقة توكن الميديا باير لا تفتح حملات الكليبر.
 */

export const DEFAULT_TOKEN_DAYS = 90;

export interface TokenRow {
  id: string;
  workspaceId: string;
  system: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  dailyDraftCap: number;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
  lastUsedAt: Date | string | null;
  createdBy: string;
  createdAt: Date | string;
}

export interface TokenView {
  id: string;
  system: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  dailyDraftCap: number;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  status: "active" | "expired" | "revoked";
}

interface TokenModel {
  create(a: unknown): Promise<unknown>;
  findUnique(a: unknown): Promise<unknown>;
  findMany(a: unknown): Promise<unknown>;
  update(a: unknown): Promise<unknown>;
}

function model(db: Db): TokenModel {
  const m = (db as unknown as { integrationToken?: TokenModel }).integrationToken;
  if (!m) throw new AppError("Integration tokens unavailable", 500, "INTERNAL");
  return m;
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

const SYSTEM_SHORT: Record<TokenSystem, string> = { mediabuyer: "mb", clipper: "clp" };

function newRawToken(system: TokenSystem): string {
  return `zr_${SYSTEM_SHORT[system]}_${crypto.randomBytes(24).toString("base64url")}`;
}

const iso = (v: Date | string | null): string | null => (v ? new Date(v).toISOString() : null);

export function tokenStatus(row: Pick<TokenRow, "expiresAt" | "revokedAt">, now = new Date()): TokenView["status"] {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

export function toTokenView(row: TokenRow): TokenView {
  return {
    id: row.id,
    system: row.system,
    name: row.name,
    prefix: row.tokenPrefix,
    scopes: row.scopes,
    rateLimitPerMin: row.rateLimitPerMin,
    dailyDraftCap: row.dailyDraftCap,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: iso(row.createdAt)!,
    status: tokenStatus(row),
  };
}

export interface CreateTokenInput {
  system: TokenSystem;
  name?: string;
  scopes?: TokenScope[];
  expiresInDays?: number;
  rateLimitPerMin?: number;
  dailyDraftCap?: number;
}

export async function createIntegrationToken(
  db: Db,
  ctx: ActorContext,
  input: CreateTokenInput
): Promise<{ token: string; view: TokenView }> {
  const preset = TOKEN_PRESETS[input.system];
  if (!preset) throw new AppError("نظام غير معروف للتوكن", 422, "UNKNOWN_TOKEN_SYSTEM");
  const allowed = new Set<string>(preset.scopes);
  const scopes = (input.scopes ?? [...preset.scopes]).filter((s) => (TOKEN_SCOPES as readonly string[]).includes(s));
  // لا صلاحية خارج حدود النظام: توكن الميديا باير لا يقدر يطلب حملات.
  for (const s of scopes) {
    if (!allowed.has(s)) throw new AppError(`الصلاحية ${s} غير مسموحة لـ ${input.system}`, 422, "SCOPE_NOT_ALLOWED");
  }
  if (scopes.length === 0) throw new AppError("صلاحية واحدة على الأقل", 422, "SCOPE_REQUIRED");
  const days = Math.min(Math.max(input.expiresInDays ?? DEFAULT_TOKEN_DAYS, 1), 365);
  const raw = newRawToken(input.system);
  const row = (await model(db).create({
    data: {
      workspaceId: ctx.workspaceId,
      system: input.system,
      name: (input.name ?? preset.nameAr).slice(0, 80),
      tokenHash: hashToken(raw),
      tokenPrefix: raw.slice(0, 12),
      scopes,
      rateLimitPerMin: Math.min(Math.max(input.rateLimitPerMin ?? 60, 1), 600),
      dailyDraftCap: Math.min(Math.max(input.dailyDraftCap ?? 20, 0), 200),
      expiresAt: new Date(Date.now() + days * 24 * 3600_000),
      createdBy: ctx.userId,
    },
  })) as TokenRow;
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "integration.token_created",
    entityType: "IntegrationToken",
    entityId: row.id,
    metadata: { system: input.system, scopes, expiresInDays: days },
  });
  return { token: raw, view: toTokenView(row) };
}

/** يتحقق من توكن Bearer: موجود · غير موقوف · غير منتهٍ. */
export async function verifyIntegrationToken(db: Db, raw: string | null | undefined, now = new Date()): Promise<TokenRow | null> {
  if (!raw || !/^zr_[a-z]{2,3}_[A-Za-z0-9_-]{20,}$/.test(raw)) return null;
  const row = (await model(db).findUnique({ where: { tokenHash: hashToken(raw) } })) as TokenRow | null;
  if (!row) return null;
  if (tokenStatus(row, now) !== "active") return null;
  return row;
}

export async function touchTokenUsage(db: Db, row: TokenRow, now = new Date()): Promise<void> {
  // تحديث مخفف: مرة بالدقيقة كحد أقصى (لا كتابة على كل نداء).
  const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
  if (now.getTime() - last < 60_000) return;
  try {
    await model(db).update({ where: { id: row.id }, data: { lastUsedAt: now } });
  } catch {
    /* observability only */
  }
}

export async function revokeIntegrationToken(db: Db, ctx: ActorContext, id: string): Promise<TokenView> {
  const row = (await model(db).findUnique({ where: { id } })) as TokenRow | null;
  if (!row || row.workspaceId !== ctx.workspaceId) throw new NotFoundError("Token");
  const updated = row.revokedAt
    ? row
    : ((await model(db).update({ where: { id }, data: { revokedAt: new Date() } })) as TokenRow);
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "integration.token_revoked",
    entityType: "IntegrationToken",
    entityId: id,
    metadata: { system: row.system },
  });
  return toTokenView(updated);
}

export async function listIntegrationTokens(db: Db, workspaceId: string): Promise<TokenView[]> {
  const rows = (await model(db).findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 })) as TokenRow[];
  return rows.map(toTokenView);
}
