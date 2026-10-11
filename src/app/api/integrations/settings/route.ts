import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { integrationSettingsSchema, updateIntegrationSettings } from "@/modules/integrations/settings";

/** P12 — حدود القدرة · نافذة الإسناد · ثقة اعتماد الكليبر · كلفة السيرفر · إيقاف باب الوكلاء. */
export const PATCH = createHandler(
  { body: integrationSettingsSchema.partial(), permission: "settings.manage" },
  async ({ auth, body }) => {
    return ok(await updateIntegrationSettings(prisma as unknown as Db, { userId: auth!.userId, workspaceId: auth!.workspaceId }, body));
  }
);
