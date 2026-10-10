import { z } from "zod";

/**
 * P9 — دورة حياة الحملة التسويقية. كل انتقال مسمى ومحدد؛ لا حالة عامة.
 * DRAFT → VALIDATING → READY → SCHEDULED → RUNNING → PAUSED/CANCELLED/COMPLETED/FAILED
 */

export const CAMPAIGN_RATE_MIN = 1;
export const CAMPAIGN_RATE_MAX = 600;
/** حجم الدفعة داخل tick (حد أقصى صريح — لا آلاف دفعة واحدة). */
export const CAMPAIGN_BATCH_MAX = 50;
/** أقصى محاولات لكل مستلم قبل FAILED نهائي. */
export const CAMPAIGN_MAX_ATTEMPTS = 5;

export const CAMPAIGN_CHANNELS = ["WHATSAPP", "TELEGRAM"] as const;
export type CampaignChannelType = (typeof CAMPAIGN_CHANNELS)[number];

/** لماذا تُرفض القناة كمسار تسويقي (مجموعة مغلقة — لا مسارات مخترعة). */
export type ChannelRefusalReason =
  | "CHANNEL_NOT_MARKETING_CAPABLE" // FACEBOOK/INSTAGRAM: لا بث خارج نافذة 24h
  | "CHANNEL_ACCESS_NOT_APPROVED"; // TIKTOK: الوصول غير معتمد محليًا

export function marketingChannelDecision(channelType: string): { allowed: true; mode: "TEMPLATE" | "DIRECT" } | { allowed: false; reason: ChannelRefusalReason } {
  if (channelType === "WHATSAPP") return { allowed: true, mode: "TEMPLATE" }; // WhatsApp Business Platform — قالب معتمد إجباري
  if (channelType === "TELEGRAM") return { allowed: true, mode: "DIRECT" }; // بوت → مشتركو البوت فقط (تحقق لكل مستلم)
  if (channelType === "TIKTOK") return { allowed: false, reason: "CHANNEL_ACCESS_NOT_APPROVED" };
  // FACEBOOK/INSTAGRAM/WEB: لا إرسال جماعي تسويقي خارج نوافذ خدمة العملاء
  // وفق سياسات Meta الرسمية — يُمنع بدل تقليده.
  return { allowed: false, reason: "CHANNEL_NOT_MARKETING_CAPABLE" };
}

export const campaignContentSchema = z
  .object({
    text: z.string().min(1).max(3000),
    templateName: z.string().min(1).max(120).optional(),
    templateLanguage: z.string().min(1).max(10).optional(),
    templateVariables: z.record(z.string()).optional(),
  })
  .strict();
export type CampaignContentInput = z.infer<typeof campaignContentSchema>;

export const campaignCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    segmentId: z.string().min(1),
    channelType: z.enum(CAMPAIGN_CHANNELS),
    channelId: z.string().min(1).optional(),
    timezone: z.string().min(1).max(60).default("UTC"),
    ratePerMinute: z.number().int().min(CAMPAIGN_RATE_MIN).max(CAMPAIGN_RATE_MAX).default(30),
    content: campaignContentSchema,
  })
  .strict();
export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;

export const campaignUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    channelId: z.string().min(1).nullable().optional(),
    timezone: z.string().min(1).max(60).optional(),
    ratePerMinute: z.number().int().min(CAMPAIGN_RATE_MIN).max(CAMPAIGN_RATE_MAX).optional(),
    content: campaignContentSchema.optional(),
  })
  .strict();

export const campaignScheduleSchema = z
  .object({
    scheduledAt: z.string().datetime().optional(),
    timezone: z.string().min(1).max(60).optional(),
  })
  .strict();

/** دوال مساعدة للانتقالات المسموحة فقط. */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["VALIDATING", "CANCELLED"],
  VALIDATING: ["READY", "DRAFT", "FAILED", "CANCELLED"],
  READY: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["RUNNING", "PAUSED", "CANCELLED"],
  RUNNING: ["PAUSED", "CANCELLED", "COMPLETED", "FAILED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  FAILED: [],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}
