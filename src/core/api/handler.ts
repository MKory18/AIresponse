import { NextRequest, NextResponse } from "next/server";
import { ZodError, ZodType, type ZodTypeDef } from "zod";
import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { getAuthContext, type AuthContext } from "@/modules/auth/context";
import type { Permission } from "@/modules/rbac/permissions";
import { rateLimitDb } from "./rate-limit";

const log = childLogger("api");

export class ApiError extends Error {
  constructor(
    public response: NextResponse,
    message = "handled"
  ) {
    super(message);
  }
}

interface RouteOptions<TBody, TQuery> {
  /** Zod schema for the JSON body. */
  body?: ZodType<TBody, ZodTypeDef, unknown>;
  /** Zod schema for search params. */
  query?: ZodType<TQuery, ZodTypeDef, unknown>;
  /** Required permission; omit for public routes. */
  permission?: Permission;
  /** Allow unauthenticated access. */
  public?: boolean;
  rateLimit?: { limit: number; windowMs: number };
  /**
   * P1: when true, rate-limit storage failure refuses with 503 instead of
   * degrading to per-process memory buckets. Use for brute-force shields
   * (login/register) which require the database anyway.
   */
  rateLimitStrict?: boolean;
}

interface HandlerArgs<TBody, TQuery> {
  req: NextRequest;
  body: TBody;
  query: TQuery;
  auth: AuthContext | null;
  /** Dynamic route params, e.g. { id } for /api/conversations/[id]. */
  params: Record<string, string | string[]>;
}

export function createHandler<TBody = unknown, TQuery = unknown>(
  options: RouteOptions<TBody, TQuery>,
  handler: (args: HandlerArgs<TBody, TQuery>) => Promise<NextResponse | Response>
) {
  return async (
    req: NextRequest,
    routeCtx?: { params: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }
  ): Promise<NextResponse | Response> => {
    const start = Date.now();
    let auth: AuthContext | null = null;
    try {
      const params = (await routeCtx?.params) ?? {};
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

      // CSRF: for state-changing browser requests, verify Origin (when present)
      // matches the Host. Meta webhooks and server-to-server calls send no
      // Origin header and are unaffected.
      const method = req.method.toUpperCase();
      if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
        const origin = req.headers.get("origin");
        if (origin) {
          const host = req.headers.get("host");
          let originHost: string | null = null;
          try { originHost = new URL(origin).host; } catch { originHost = null; }
          if (!host || originHost !== host) {
            log.warn({ path: new URL(req.url).pathname }, "csrf_origin_rejected");
            return NextResponse.json({ error: "CSRF_REJECTED" }, { status: 403 });
          }
        }
      }

      // Payload size guard (reject before expensive processing).
      const contentLength = Number(req.headers.get("content-length") ?? 0);
      if (contentLength > 110 * 1024 * 1024) {
        return NextResponse.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
      }
      if (options.rateLimit) {
        await rateLimitDb(`${ip}:${new URL(req.url).pathname}`, options.rateLimit.limit, options.rateLimit.windowMs, {
          onStorageFailure: options.rateLimitStrict ? "fail-closed" : "memory-fallback",
        });
      }

      if (!options.public) {
        auth = await getAuthContext();
        if (options.permission) auth.require(options.permission);
      }

      let body = undefined as TBody;
      if (options.body) {
        const raw = await req.json().catch(() => {
          throw new AppError("Invalid JSON body", 400, "INVALID_BODY");
        });
        body = options.body.parse(raw);
      }

      let query = undefined as TQuery;
      if (options.query) {
        const params = Object.fromEntries(new URL(req.url).searchParams.entries());
        query = options.query.parse(params);
      }

      const res = await handler({ req, body, query, auth, params });
      log.info({ method: req.method, path: new URL(req.url).pathname, status: res.status, ms: Date.now() - start }, "api_request");
      return res;
    } catch (err) {
      return handleError(err, req, Date.now() - start);
    }
  };
}

export function handleError(err: unknown, req: NextRequest, ms: number): NextResponse {
  const safePath = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return "(unparseable)";
    }
  })();
  if (err instanceof ApiError) return err.response;
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 422 }
    );
  }
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      log.error({ err, path: safePath, ms }, "api_error");
    } else {
      log.warn({ code: err.code, msg: err.message, path: safePath, ms }, "api_rejected");
    }
    return NextResponse.json(
      { error: err.code, message: err.message, details: err.details ?? undefined },
      { status: err.statusCode }
    );
  }
  // OCR-2026-10-16: pathname فقط — req.url الكامل كان يحمل بحث الهاتف/الاسم
  // (خصوصية: ولا بيانات زبون في السجلات) إلى سجلات الأخطاء.
  log.error({ err, path: safePath, ms }, "api_unhandled_error");
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}
