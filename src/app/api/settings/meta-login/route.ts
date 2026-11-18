import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getEnv } from "@/core/env";
import { getIntegrationSettings, updateIntegrationSettings } from "@/modules/integrations/settings";
import { resolveLoginConfigId } from "@/modules/channels/facebook/oauth";

/**
 * «ربط ميتا» — رقم إعداد تسجيل الدخول (config_id) لتطبيق ميتا نوع Business،
 * محفوظ لكل مساحة بـ Workspace.integrationSettings (بلا متغيّرات خادم).
 *
 * GET — الرقم المحفوظ + هل في قيمة احتياط بالبيئة + أي مصدر هو الفعّال.
 * PUT — حفظ الرقم (فاضي = مسح، فبترجع القيمة من البيئة إن وُجدت).
 * الرقم مش سرّي (بيظهر برابط الموافقة)، فبينعرض كامل.
 */
const bodySchema = z.object({
  configId: z
    .string()
    .trim()
    .max(32)
    .refine((v) => v === "" || /^\d{5,32}$/.test(v), { message: "رقم الإعداد لازم يكون أرقام بس (من لوحة تطبيق ميتا)." }),
});

async function state(workspaceId: string) {
  const { metaLoginConfigId } = await getIntegrationSettings(prisma, workspaceId);
  const envConfigured = Boolean((getEnv().META_LOGIN_CONFIG_ID ?? "").trim());
  const { source } = resolveLoginConfigId(metaLoginConfigId, getEnv().META_LOGIN_CONFIG_ID);
  return { configId: metaLoginConfigId, envConfigured, source };
}

export const GET = createHandler({ permission: "integrations.manage" }, async ({ auth }) => {
  return ok(await state(auth!.workspaceId));
});

export const PUT = createHandler(
  { body: bodySchema, permission: "integrations.manage" },
  async ({ auth, body }) => {
    const workspaceId = auth!.workspaceId;
    await updateIntegrationSettings(
      prisma,
      { workspaceId, userId: auth!.userId } as Parameters<typeof updateIntegrationSettings>[1],
      { metaLoginConfigId: body.configId === "" ? null : body.configId }
    );
    return ok(await state(workspaceId));
  }
);
