/**
 * ولا رسالة زبون بتنتجاهل.
 *
 * كل اختبار هون بيغطّي مكان كان النظام فيه بيرمي رسالة زبون بصمت:
 * رقم واتساب تاني بنفس الدفعة · كبسة زر بالماسنجر · صوتية بتيليغرام ·
 * رسالة تيك توك بلا نص · دفعة بلا مساحة · ومهمة رد خلصت محاولاتها.
 *
 * ⚠️ قاعدة بالذاكرة ومسار إرسال وهمي — سلوك، مش زمن إنتاج.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { ingestWhatsAppWebhook } from "@/modules/channels/whatsapp/webhook";
import { normalizeFacebookWebhook } from "@/modules/channels/facebook/normalizer";
import { normalizeTelegramUpdate } from "@/modules/channels/telegram/normalizer";
import { normalizeTikTokEvent } from "@/modules/channels/tiktok/normalizer";
import { handleChannelInbound } from "@/modules/channels/inbound-job";
import { sendLastResortReply, LAST_RESORT_REPLY } from "@/modules/ai/last-resort";

const sends: Array<{ text: string; sourceMessageId?: string }> = [];
vi.mock("@/modules/channels/outbound", () => ({
  dispatchOutbound: vi.fn(async (_db: unknown, params: { text: string; sourceMessageId?: string }) => {
    sends.push({ text: params.text, sourceMessageId: params.sourceMessageId });
    return { messageId: `out-${sends.length}`, deliveryStatus: "SENT" };
  }),
}));

type Db = Prisma.TransactionClient;
const WS = "ws-no-ignore";
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
  sends.length = 0;
});

async function seedAccount(opts: { provider: string; externalAccountId: string; channelType: string }) {
  const ch = (await db.channel.create({
    data: {
      workspaceId: WS,
      type: opts.channelType,
      status: "CONNECTED",
      displayName: "X",
      externalId: opts.externalAccountId,
    },
  } as never)) as unknown as { id: string };
  await db.channelAccount.create({
    data: {
      channelId: ch.id,
      provider: opts.provider,
      externalAccountId: opts.externalAccountId,
      encryptedCredentials: encryptSecret("fixture-token"),
      metadata: {} as never,
    },
  } as never);
  return ch;
}

describe("رقمين واتساب بنفس الدفعة: ولا رقم بيضيع", () => {
  function change(phoneNumberId: string, wamid: string) {
    return {
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "1555", phone_number_id: phoneNumberId },
        messages: [{ from: "963930000001", id: wamid, timestamp: "1720000000", type: "text", text: { body: "مرحبا" } }],
      },
    };
  }

  it("رسالة كل رقم بتوصل — مش بس الأول", async () => {
    await seedAccount({ provider: "WHATSAPP", externalAccountId: "num-A", channelType: "WHATSAPP" });
    await seedAccount({ provider: "WHATSAPP", externalAccountId: "num-B", channelType: "WHATSAPP" });
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [change("num-A", "wamid.A"), change("num-B", "wamid.B")] }],
    };
    const res = await ingestWhatsAppWebhook(db as unknown as Db, payload);
    expect(res.status).toBe("OK");
    // قبل التصليح: الرقم التاني بياخد نفس مفتاح الحدث وبينحسب «مكرر» → 1.
    expect(res.normalizedCount).toBe(2);
    const jobs = (db as unknown as { _stores: { backgroundJob: Array<{ type: string }> } })._stores.backgroundJob;
    expect(jobs.filter((j) => j.type === "process_channel_inbound")).toHaveLength(2);
  });

  it("إعادة تسليم نفس الدفعة بتضل مكرر (ما منرد مرتين)", async () => {
    await seedAccount({ provider: "WHATSAPP", externalAccountId: "num-A", channelType: "WHATSAPP" });
    await seedAccount({ provider: "WHATSAPP", externalAccountId: "num-B", channelType: "WHATSAPP" });
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [change("num-A", "wamid.A"), change("num-B", "wamid.B")] }],
    };
    await ingestWhatsAppWebhook(db as unknown as Db, payload);
    const again = await ingestWhatsAppWebhook(db as unknown as Db, payload);
    expect(again.status).toBe("DUPLICATE");
  });
});

describe("كبسة زر بالماسنجر = رسالة زبون", () => {
  it("«ابدأ» بتنحسب رسالة بنص الزر", () => {
    const out = normalizeFacebookWebhook(
      {
        object: "page",
        entry: [
          {
            id: "page-1",
            messaging: [
              {
                sender: { id: "psid-1" },
                recipient: { id: "page-1" },
                timestamp: 1720000000,
                postback: { title: "ابدأ", payload: "GET_STARTED" },
              },
            ],
          },
        ],
      } as never,
      "acc-1",
      "page-1",
      "raw-1"
    );
    // قبل التصليح: الحدث بلا message كان بينرمى → 0.
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("ابدأ");
    expect(out[0].externalCustomerId).toBe("psid-1");
  });

  it("نفس الكبسة مرتين = نفس المفتاح (بلا رد مكرر)", () => {
    const event = {
      object: "page",
      entry: [
        {
          id: "page-1",
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              timestamp: 1720000000,
              postback: { title: "ابدأ", payload: "GET_STARTED" },
            },
          ],
        },
      ],
    } as never;
    const a = normalizeFacebookWebhook(event, "acc-1", "page-1", "raw-1");
    const b = normalizeFacebookWebhook(event, "acc-1", "page-1", "raw-1");
    expect(a[0].externalEventId).toBe(b[0].externalEventId);
  });

  it("صدى رسالتنا بيضل منرمي", () => {
    const out = normalizeFacebookWebhook(
      {
        object: "page",
        entry: [
          {
            id: "page-1",
            messaging: [
              { sender: { id: "page-1" }, recipient: { id: "psid-1" }, timestamp: 1, message: { mid: "m1", text: "رد", is_echo: true } },
            ],
          },
        ],
      } as never,
      "acc-1",
      "page-1",
      "raw-1"
    );
    expect(out).toHaveLength(0);
  });
});

describe("رسالة بلا نص بتوصل كمان", () => {
  it("صوتية بتيليغرام بتنسجّل", () => {
    const out = normalizeTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        from: { id: 555, first_name: "Sara" },
        chat: { id: 555, type: "private" },
        date: 1720000000,
        voice: { file_id: "voice-1" },
      },
    });
    // قبل التصليح: بلا نص ولا صورة ولا ملف → null.
    expect(out).not.toBeNull();
    expect(out?.mediaFileId).toBe("voice-1");
  });

  it("ملصق بتيليغرام بينسجّل والإيموجي بيصير نصه", () => {
    const out = normalizeTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 8,
        from: { id: 555, first_name: "Sara" },
        chat: { id: 555, type: "private" },
        date: 1720000000,
        sticker: { file_id: "stk-1", emoji: "🌹" },
      },
    });
    expect(out?.text).toBe("🌹");
  });

  it("رد البوت بيضل منرمي", () => {
    const out = normalizeTelegramUpdate({
      update_id: 3,
      message: {
        message_id: 9,
        from: { id: 1, first_name: "Bot", is_bot: true },
        chat: { id: 555, type: "private" },
        date: 1720000000,
        text: "أهلين",
      },
    });
    expect(out).toBeNull();
  });

  it("تحديث بلا محتوى زبون بيضل منرمي", () => {
    const out = normalizeTelegramUpdate({
      update_id: 4,
      message: {
        message_id: 10,
        from: { id: 555, first_name: "Sara" },
        chat: { id: 555, type: "private" },
        date: 1720000000,
      },
    });
    expect(out).toBeNull();
  });

  it("رسالة تيك توك بلا نص بتنسجّل", () => {
    const out = normalizeTikTokEvent({
      conversation_id: "c1",
      sender_id: "s1",
      message_id: "m1",
      timestamp: 1720000000,
    } as never);
    // قبل التصليح: بلا نص → null.
    expect(out).not.toBeNull();
    expect(out?.text).toBeNull();
  });
});

describe("دفعة رسائل بلا مساحة ما بتنحسب «تمّت»", () => {
  it("بتفشل بصوت عالي ليعيد الطابور المحاولة", async () => {
    const res = await handleChannelInbound(db as unknown as Db, {
      messages: [{ channelType: "FACEBOOK", externalConversationId: "c1" }],
    });
    // قبل التصليح: { success: true } والدفعة بتختفي بلا أثر.
    expect(res.success).toBe(false);
    expect(res.error).toBe("MISSING_WORKSPACE_CONTEXT");
  });
});

describe("خلصت محاولات الرد: الزبون بياخد رد آمن بدل السكوت", () => {
  async function seedThread(over: { aiState?: string; aiEnabled?: boolean } = {}) {
    const conversation = (await db.conversation.create({
      data: {
        workspaceId: WS,
        customerId: "cust-1",
        channelId: "ch-1",
        status: "OPEN",
        aiState: over.aiState ?? "AI_ACTIVE",
        aiEnabled: over.aiEnabled ?? true,
      },
    } as never)) as unknown as { id: string };
    const message = (await db.message.create({
      data: {
        workspaceId: WS,
        conversationId: conversation.id,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        content: "قديش السعر؟",
      },
    } as never)) as unknown as { id: string };
    return { conversation, message };
  }

  it("بيبعت النص الآمن", async () => {
    const { conversation, message } = await seedThread();
    const out = await sendLastResortReply(db as unknown as Db, {
      workspaceId: WS,
      conversationId: conversation.id,
      messageId: message.id,
      reason: "PERMANENT: test",
    });
    expect(out).toBe("SENT");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe(LAST_RESORT_REPLY);
    expect(sends[0].sourceMessageId).toBe(`${message.id}:last-resort`);
  });

  it("ما بيبعت إذا الموظف مستلم المحادثة", async () => {
    const { conversation, message } = await seedThread({ aiState: "HUMAN_ACTIVE", aiEnabled: false });
    const out = await sendLastResortReply(db as unknown as Db, {
      workspaceId: WS,
      conversationId: conversation.id,
      messageId: message.id,
      reason: "PERMANENT: test",
    });
    expect(out).toBe("SKIPPED_HUMAN");
    expect(sends).toHaveLength(0);
  });

  it("ما بيبعت إذا الزبون أصلًا أخد رد بعدها", async () => {
    const { conversation, message } = await seedThread();
    const reply = (await db.message.create({
      data: {
        workspaceId: WS,
        conversationId: conversation.id,
        direction: "OUTBOUND",
        senderType: "AI",
        content: "أهلين",
        deliveryStatus: "SENT",
      },
    } as never)) as unknown as { id: string };
    await db.message.update({
      where: { id: reply.id },
      data: { createdAt: new Date(Date.now() + 60_000) },
    } as never);
    const out = await sendLastResortReply(db as unknown as Db, {
      workspaceId: WS,
      conversationId: conversation.id,
      messageId: message.id,
      reason: "PERMANENT: test",
    });
    expect(out).toBe("SKIPPED_ANSWERED");
    expect(sends).toHaveLength(0);
  });
});
