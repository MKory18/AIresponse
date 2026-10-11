import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { prisma } from "@/core/db/prisma";
import { rateLimitDb } from "@/core/api/rate-limit";
import type { Db } from "@/modules/customers/service";
import type { TokenScope } from "./systems";
import { touchTokenUsage, verifyIntegrationToken, type TokenRow } from "./tokens";
import { newRequestId } from "./signing";

/**
 * P12 — غلاف مسارات /api/v1 التي تناديها أنظمة المنظومة (لا متصفح).
 * توكن Bearer لكل نظام → مساحة العمل مشتقة من التوكن نفسه (لا من الطلب) ·
 * صلاحية مسماة · حد طلبات لكل توكن · X-Request-Id بالرد · خطأ موحّد:
 *   {"error": {"code","message","details"}, "request_id"}
 */

const log = childLogger("api.v1");

export interface SystemRequest {
  req: NextRequest;
  db: Db;
  token: TokenRow;
  workspaceId: string;
  requestId: string;
  params: Record<string, string | string[]>;
}

export function sanitizeRequestId(raw: string | null): string {
  const v = raw?.trim();
  return v && /^[A-Za-z0-9_\-:.]{1,64}$/.test(v) ? v : newRequestId();
}

export function v1Error(status: number, code: string, message: string, requestId: string, details: unknown[] = []): NextResponse {
  return NextResponse.json(
    { error: { code, message, details }, request_id: requestId },
    { status, headers: { "x-request-id": requestId } }
  );
}

export function v1Json(body: unknown, requestId: string, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId } });
}

export function bearerFrom(req: NextRequest): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/** يحسم توكن الطلب أو يرجّع ردّ الرفض الجاهز. */
export async function authenticateSystem(
  req: NextRequest,
  db: Db,
  scope: TokenScope,
  requestId: string
): Promise<{ ok: true; token: TokenRow } | { ok: false; response: NextResponse }> {
  const token = await verifyIntegrationToken(db, bearerFrom(req));
  if (!token) return { ok: false, response: v1Error(401, "UNAUTHORIZED", "توكن غلط أو منتهي أو موقوف", requestId) };
  if (!token.scopes.includes(scope)) {
    return { ok: false, response: v1Error(403, "SCOPE_NOT_ALLOWED", `هالتوكن ما عنده صلاحية ${scope}`, requestId) };
  }
  try {
    await rateLimitDb(`itok:${token.id}`, token.rateLimitPerMin, 60_000);
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") {
      return { ok: false, response: v1Error(429, "RATE_LIMITED", "فوق حد الطلبات بالدقيقة", requestId) };
    }
    throw err;
  }
  await touchTokenUsage(db, token);
  return { ok: true, token };
}

export function createSystemHandler(
  opts: { scope: TokenScope },
  handler: (ctx: SystemRequest) => Promise<NextResponse>
) {
  return async (
    req: NextRequest,
    routeCtx?: { params: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }
  ): Promise<NextResponse> => {
    const started = Date.now();
    const requestId = sanitizeRequestId(req.headers.get("x-request-id"));
    const db = prisma as unknown as Db;
    try {
      const params = (await routeCtx?.params) ?? {};
      const auth = await authenticateSystem(req, db, opts.scope, requestId);
      if (!auth.ok) return auth.response;
      const res = await handler({ req, db, token: auth.token, workspaceId: auth.token.workspaceId, requestId, params });
      log.info(
        { path: new URL(req.url).pathname, status: res.status, ms: Date.now() - started, system: auth.token.system, requestId },
        "v1_request"
      );
      return res;
    } catch (err) {
      if (err instanceof ZodError) {
        return v1Error(
          422,
          "VALIDATION_FAILED",
          "مدخلات غلط",
          requestId,
          err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
        );
      }
      if (err instanceof AppError) {
        if (err.statusCode >= 500) log.error({ err, requestId }, "v1_error");
        return v1Error(err.statusCode, err.code, err.message, requestId, Array.isArray(err.details) ? err.details : []);
      }
      log.error({ err, requestId }, "v1_unhandled_error");
      return v1Error(500, "INTERNAL", "خطأ داخلي", requestId);
    }
  };
}
