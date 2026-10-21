import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { INTEL_FIELD_KINDS } from "@/modules/intelligence/fields";
import { getCollectionFields, saveCollectionFields } from "@/modules/intelligence/settings";

const fieldSchema = z.object({
  key: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(40),
  kind: z.enum(INTEL_FIELD_KINDS),
  required: z.boolean(),
  enabled: z.boolean(),
});

const bodySchema = z.object({
  fields: z.array(fieldSchema).min(1).max(30),
});

/**
 * GET /api/intelligence/fields — «البيانات المطلوب تجميعها» لهذه المساحة.
 * غياب أي تخصيص = الافتراضي (كل حقول الكتالوج مفعّلة).
 */
export const GET = createHandler(
  { permission: "conversations.read" },
  async ({ auth }) => {
    const fields = await getCollectionFields(prisma as never, auth!.workspaceId);
    return ok({ fields });
  }
);

/** PUT — حفظ اختيار المالك: تفعيل/إلزام/إضافة حقول خاصة. */
export const PUT = createHandler(
  { body: bodySchema, permission: "settings.manage", rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ auth, body }) => {
    const result = await saveCollectionFields(prisma as never, auth!.workspaceId, body.fields);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return ok({ fields: result.fields });
  }
);
