import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { changeOrderRules, shadowReadiness } from "@/modules/orders/reader/cutover";

/**
 * «قواعد الطلب» (الحزمة 1.9): وضع قارئ الطلب + إعداداته + معيار القطع بالأرقام.
 * قراءة: `ai.configure`. تغيير **الوضع** للمالك فقط (الخدمة بتفرضها)، وبقية الإعدادات `ai.configure`.
 */
export const GET = createHandler({ permission: "ai.configure" }, async ({ auth }) => {
  const settings = await getIntegrationSettings(prisma as never, auth!.workspaceId);
  const readiness = await shadowReadiness(prisma as never, auth!.workspaceId);
  return ok({
    settings: {
      orderMode: settings.orderMode,
      orderSettleMinutes: settings.orderSettleMinutes,
      orderAutoSeal: settings.orderAutoSeal,
      orderAgreementPolicy: settings.orderAgreementPolicy,
      orderConfirmMessage: settings.orderConfirmMessage,
    },
    readiness,
    canChangeMode: auth!.role === "OWNER",
  });
});

const patchSchema = z
  .object({
    orderMode: z.enum(["LEGACY_DRAFT", "READER_SHADOW", "READER"]).optional(),
    orderSettleMinutes: z.number().int().min(2).max(120).optional(),
    orderAutoSeal: z.boolean().optional(),
    orderAgreementPolicy: z.enum(["EXPLICIT_OR_IMPLICIT", "EXPLICIT_ONLY"]).optional(),
    orderConfirmMessage: z.boolean().optional(),
    confirmReviewed: z.boolean().optional(),
    acknowledgeRisks: z.boolean().optional(),
  })
  .strict();

export const PATCH = createHandler({ permission: "ai.configure", body: patchSchema }, async ({ auth, body }) => {
  const result = await changeOrderRules(prisma as never, { userId: auth!.userId, workspaceId: auth!.workspaceId, role: auth!.role }, body);
  return ok(result);
});
