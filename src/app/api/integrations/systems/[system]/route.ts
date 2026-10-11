import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { AppError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { saveIntegrationConnection } from "@/modules/integrations/connections";
import { isGenericSystem, type GenericSystem } from "@/modules/integrations/systems";

const bodySchema = z
  .object({
    baseUrl: z.string().max(500).nullable().optional(),
    eventsUrl: z.string().max(500).nullable().optional(),
    // فارغ = بلا تغيير؛ المسح صريح بـ clear*.
    token: z.string().max(500).optional(),
    eventsSecret: z.string().max(200).optional(),
    generateEventsSecret: z.boolean().optional(),
    clearToken: z.boolean().optional(),
    clearEventsSecret: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * P12 — حفظ اتصال نظام (الرابط · التوكن · سر الأحداث). الأسرار بتتشفر فورًا
 * وما بترجع؛ السر المولّد هنا بيرجع مرة وحدة بس لتنسخه للنظام التاني.
 */
export const POST = createHandler({ body: bodySchema, permission: "settings.manage" }, async ({ auth, body, params }) => {
  const system = String(params.system ?? "");
  if (!isGenericSystem(system)) throw new AppError("نظام غير معروف", 404, "UNKNOWN_SYSTEM");
  if (body.eventsSecret && body.eventsSecret.trim().length < 16) {
    throw new AppError("سر الأحداث قصير — 16 حرف على الأقل", 422, "EVENTS_SECRET_TOO_SHORT");
  }
  if (body.token && body.token.trim().length < 8) throw new AppError("التوكن قصير", 422, "TOKEN_TOO_SHORT");
  const res = await saveIntegrationConnection(prisma as unknown as Db, { userId: auth!.userId, workspaceId: auth!.workspaceId }, system as GenericSystem, {
    baseUrl: body.baseUrl === undefined ? undefined : body.baseUrl?.trim() || null,
    eventsUrl: body.eventsUrl === undefined ? undefined : body.eventsUrl?.trim() || null,
    token: body.token?.trim() || null,
    eventsSecret: body.eventsSecret?.trim() || null,
    generateEventsSecret: body.generateEventsSecret,
    clearToken: body.clearToken,
    clearEventsSecret: body.clearEventsSecret,
    enabled: body.enabled,
  });
  return ok(res);
});
