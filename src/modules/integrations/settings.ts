import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";

/**
 * P12 — إعدادات الربط لكل مساحة عمل (Workspace.integrationSettings).
 * مفاتيح مسماة بحدود؛ أي قيمة ناقصة أو تالفة ترجع للافتراضي الآمن.
 */

export const integrationSettingsSchema = z
  .object({
    /** إنذار القدرة: عدد المحادثات المنتظرة ردًا. */
    capacityUnansweredWarn: z.number().int().min(1).max(10_000),
    /** إنذار القدرة: وسيط أول رد بالدقائق (آخر 24 ساعة). */
    capacityP50WarnMin: z.number().int().min(1).max(1_440),
    /** «حرج» = ضعف حد الإنذار (أو أكثر). */
    capacityCriticalMultiplier: z.number().min(1.2).max(10),
    /** نافذة الإسناد بالأيام: أول لمسة تفتح حلقة لا تُستبدل داخلها. */
    attributionWindowDays: z.number().int().min(1).max(28),
    /** حملات الكليبر المعتمدة من المالك هناك تنطلق بلا اعتماد ثانٍ هنا. */
    trustClipperApprovals: z.boolean(),
    /** كلفة السيرفر اليومية المبلّغة للمالية (نص عشري) — null = لا تُبلّغ. */
    serverCostUsdPerDay: z.string().regex(/^\d{1,6}\.\d{2}$/).nullable(),
    /** زر إيقاف باب الوكلاء (Hermes): كل نداء بيرجع 401 بلا ما ينحذف التوكن. */
    agentDoorPaused: z.boolean(),
  })
  .strict();

export type IntegrationSettings = z.infer<typeof integrationSettingsSchema>;

export const DEFAULT_INTEGRATION_SETTINGS: IntegrationSettings = {
  capacityUnansweredWarn: 30,
  capacityP50WarnMin: 15,
  capacityCriticalMultiplier: 2,
  attributionWindowDays: 7,
  trustClipperApprovals: false,
  serverCostUsdPerDay: null,
  agentDoorPaused: false,
};

/** يدمج المحفوظ مع الافتراضي حقلًا حقلًا (القيمة التالفة تسقط وحدها). */
export function resolveIntegrationSettings(raw: unknown): IntegrationSettings {
  const out: Record<string, unknown> = { ...DEFAULT_INTEGRATION_SETTINGS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const shape = integrationSettingsSchema.shape;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const field = (shape as Record<string, z.ZodTypeAny>)[k];
      if (field && field.safeParse(v).success) out[k] = v;
    }
  }
  return out as IntegrationSettings;
}

export async function getIntegrationSettings(db: Db, workspaceId: string): Promise<IntegrationSettings> {
  try {
    const ws = (await (db as unknown as { workspace?: { findUnique: (a: unknown) => Promise<unknown> } }).workspace?.findUnique({
      where: { id: workspaceId },
      select: { integrationSettings: true },
    })) as { integrationSettings?: unknown } | null | undefined;
    return resolveIntegrationSettings(ws?.integrationSettings);
  } catch {
    return { ...DEFAULT_INTEGRATION_SETTINGS };
  }
}

export async function updateIntegrationSettings(
  db: Db,
  ctx: ActorContext,
  patch: Partial<IntegrationSettings>
): Promise<IntegrationSettings> {
  const parsed = integrationSettingsSchema.partial().parse(patch);
  const current = await getIntegrationSettings(db, ctx.workspaceId);
  const next = { ...current, ...parsed };
  await (db as unknown as { workspace: { update: (a: unknown) => Promise<unknown> } }).workspace.update({
    where: { id: ctx.workspaceId },
    data: { integrationSettings: next as unknown as Prisma.InputJsonValue },
  });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "integration.settings_updated",
    entityType: "Workspace",
    entityId: ctx.workspaceId,
    metadata: { changed: Object.keys(parsed) },
  });
  return next;
}
