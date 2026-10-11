import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { prisma } from "@/core/db/prisma";
import { rateLimitDb } from "@/core/api/rate-limit";
import type { Db } from "@/modules/customers/service";
import { bearerFrom, sanitizeRequestId } from "@/modules/integrations/system-handler";
import { touchTokenUsage, verifyIntegrationToken, type TokenRow } from "@/modules/integrations/tokens";
import { DoorError, doorErrorBody } from "./door";

/**
 * P12 — غلاف مسارات باب الوكلاء: نفس توكنات /api/v1 لكن بشكل خطأ العقد
 * {"status":"error","error":{...},"request_id"} ورأس X-Request-Id راجع دايمًا.
 */

const log = childLogger("agent-door.http");

export interface DoorRequestCtx {
  req: NextRequest;
  db: Db;
  token: TokenRow;
  requestId: string;
}

export function doorJson(body: unknown, requestId: string, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
}

export function doorError(err: DoorError, requestId: string): NextResponse {
  return doorJson(doorErrorBody(err, requestId), requestId, err.httpStatus);
}

export function withAgentDoor(handler: (ctx: DoorRequestCtx) => Promise<NextResponse>, opts: { db?: Db } = {}) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const requestId = sanitizeRequestId(req.headers.get("x-request-id"));
    const db = opts.db ?? (prisma as unknown as Db);
    try {
      const token = await verifyIntegrationToken(db, bearerFrom(req));
      if (!token) return doorError(new DoorError(401, "UNAUTHORIZED", "توكن غلط أو منتهي أو موقوف"), requestId);
      try {
        await rateLimitDb(`itok:${token.id}`, token.rateLimitPerMin, 60_000);
      } catch (err) {
        if (err instanceof AppError && err.code === "RATE_LIMITED") {
          return doorError(new DoorError(429, "RATE_LIMITED", `فوق حد ${token.rateLimitPerMin} طلب بالدقيقة`), requestId);
        }
        throw err;
      }
      await touchTokenUsage(db, token);
      return await handler({ req, db, token, requestId });
    } catch (err) {
      if (err instanceof DoorError) return doorError(err, requestId);
      log.error({ err, requestId }, "agent_door_route_error");
      return doorError(new DoorError(500, "INTERNAL", "خطأ داخلي"), requestId);
    }
  };
}
