import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { testIntegrationConnection } from "@/modules/integrations/probe";

/** P12 — «اختبر الاتصال»: قراءة صحة النظام فقط — بلا حدث حقيقي. */
export const POST = createHandler(
  { permission: "settings.manage", rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ auth, params }) => {
    return ok(await testIntegrationConnection(prisma as unknown as Db, auth!.workspaceId, String(params.system ?? "")));
  }
);
