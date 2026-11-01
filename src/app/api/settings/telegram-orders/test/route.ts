import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { decryptSecret } from "@/core/crypto";
import { AppError } from "@/core/errors";
import { getTelegramClient, TelegramApiError } from "@/modules/channels/telegram/client";

/**
 * P19 — اختبار بوت تيليجرام: getMe ثم رسالة اختبار للمجموعة/التوبيك.
 *
 * لا يرسل أي بيانات زبون — نص ثابت. التوكن لا يظهر بالنتيجة أو اللوج.
 */
export const POST = createHandler(
  { permission: "settings.manage", rateLimit: { limit: 5, windowMs: 60_000 } },
  async ({ auth }) => {
    const settings = await prisma.telegramOrderSettings.findUnique({
      where: { workspaceId: auth!.workspaceId },
    });
    if (!settings?.botTokenEnc || !settings.chatId) {
      throw new AppError("احفظ توكن البوت ورقم المجموعة أولًا.", 422, "TELEGRAM_CONFIG_MISSING");
    }

    let topic: number | undefined;
    if (settings.topicId) {
      const n = Number(settings.topicId);
      if (Number.isInteger(n) && n > 0) topic = n;
    }

    const client = getTelegramClient();
    const token = decryptSecret(settings.botTokenEnc);
    try {
      const me = await client.getMe(token);
      const sent = await client.sendMessage(token, settings.chatId, {
        text: "✅ اختبار ربط طلبات Zaki — الطلبات الجاهزة رح توصل هون.",
        parseMode: "HTML",
        ...(topic ? { messageThreadId: topic } : {}),
      });
      return ok({ ok: true, botUsername: me.username, messageId: sent.messageId, chatId: settings.chatId, topicId: settings.topicId });
    } catch (err) {
      if (err instanceof TelegramApiError) {
        // description من تيليجرام آمنة (بلا توكن) — تساعد المالك يصحح chat_id/التوبيك.
        throw new AppError(
          `فشل اختبار تيليجرام: ${err.message}`,
          422,
          `TELEGRAM_${err.kind}_${err.code ?? "ERROR"}`
        );
      }
      throw err;
    }
  }
);
