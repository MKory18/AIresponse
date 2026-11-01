import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { encryptSecret } from "@/core/crypto";
import { recordAudit } from "@/modules/audit/service";
import { AppError } from "@/core/errors";

/**
 * P19 — إعدادات بوت تيليجرام الذي يستقبل الطلبات الجاهزة.
 *
 * GET  — الحالة فقط (وجود التوكن boolean، بلا قيمة أبدًا).
 * PUT  — تفعيل/تعطيل + توكن البوت (مشفّر) + chat_id + topic_id.
 *
 * ⚠️ بيانات الطلب (اسم/هاتف/عنوان) تُرسل لهذه المجموعة — المجموعة لازم تكون
 * خاصة وبيد المالك. التوكن لا يُعاد ولا يُسجَّل.
 */
const bodySchema = z.object({
  enabled: z.boolean(),
  chatId: z.string().trim().max(64).nullable().optional(),
  topicId: z
    .string()
    .trim()
    .max(32)
    .nullable()
    .optional()
    .refine((v) => v === undefined || v === null || v === "" || /^-?\d+$/.test(v), {
      message: "topic_id لازم يكون رقمًا",
    }),
  /** يُرسل فقط عند إدخال/تغيير التوكن. */
  botToken: z.string().trim().min(20).max(200).optional(),
});

export const GET = createHandler(
  { permission: "settings.manage" },
  async ({ auth }) => {
    const settings = await prisma.telegramOrderSettings.findUnique({
      where: { workspaceId: auth!.workspaceId },
    });
    return ok({
      enabled: settings?.enabled ?? false,
      chatId: settings?.chatId ?? null,
      topicId: settings?.topicId ?? null,
      hasToken: Boolean(settings?.botTokenEnc),
    });
  }
);

export const PUT = createHandler(
  { body: bodySchema, permission: "settings.manage" },
  async ({ auth, body }) => {
    const workspaceId = auth!.workspaceId;
    const existing = await prisma.telegramOrderSettings.findUnique({ where: { workspaceId } });
    const chatId = body.chatId?.trim() || existing?.chatId || null;
    const topicId = body.topicId?.trim() || null;
    const tokenEnc = body.botToken ? encryptSecret(body.botToken) : existing?.botTokenEnc ?? null;

    if (body.enabled && (!chatId || !tokenEnc)) {
      throw new AppError(
        "لتفعيل إرسال الطلبات: لازم توكن البوت ورقم المجموعة (chat_id).",
        422,
        "TELEGRAM_CONFIG_INCOMPLETE"
      );
    }

    const settings = await prisma.telegramOrderSettings.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        enabled: body.enabled,
        chatId,
        topicId,
        botTokenEnc: tokenEnc,
      },
      update: {
        enabled: body.enabled,
        chatId,
        topicId,
        ...(body.botToken ? { botTokenEnc: tokenEnc } : {}),
      },
    });

    await recordAudit(prisma, {
      workspaceId,
      userId: auth!.userId,
      action: "telegram_orders.settings_updated",
      entityType: "Workspace",
      entityId: workspaceId,
      // بلا توكن — وجود/تدوير فقط.
      metadata: {
        enabled: settings.enabled,
        hasChatId: Boolean(settings.chatId),
        hasTopicId: Boolean(settings.topicId),
        tokenRotated: Boolean(body.botToken),
      },
    });

    return ok({
      enabled: settings.enabled,
      chatId: settings.chatId,
      topicId: settings.topicId,
      hasToken: Boolean(settings.botTokenEnc),
    });
  }
);
