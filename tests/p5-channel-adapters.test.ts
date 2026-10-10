import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import {
  CHANNEL_CAPABILITIES,
  ChannelFeatureError,
} from "@/modules/channels/types";
import {
  ChannelNotSupportedError,
  getChannelAdapter,
  setChannelAdapterFactory,
} from "@/modules/channels/registry";
import { InstagramChannelAdapter } from "@/modules/channels/instagram/adapter";
import {
  deriveInstagramEventId,
  verifyInstagramSignature,
} from "@/modules/channels/instagram/normalizer";
import { canSendInstagram } from "@/modules/channels/instagram/policy";
import { TelegramChannelAdapter } from "@/modules/channels/telegram/adapter";
import {
  deriveTelegramEventId,
  normalizeTelegramUpdate,
  verifyTelegramWebhook,
} from "@/modules/channels/telegram/normalizer";
import { canSendTelegram } from "@/modules/channels/telegram/policy";
import { WhatsAppChannelAdapter } from "@/modules/channels/whatsapp/adapter";
import {
  deriveWhatsAppEventId,
  normalizeWhatsAppWebhook,
  verifyWhatsAppSignature,
} from "@/modules/channels/whatsapp/normalizer";
import { canSendWhatsApp } from "@/modules/channels/whatsapp/policy";
import { TikTokChannelAdapter } from "@/modules/channels/tiktok/adapter";
import {
  deriveTikTokEventId,
  normalizeTikTokEvent,
  verifyTikTokWebhook,
} from "@/modules/channels/tiktok/normalizer";
import { canSendTikTok } from "@/modules/channels/tiktok/policy";
import nodeCrypto from "node:crypto";

type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
  setChannelAdapterFactory("FACEBOOK", null);
  setChannelAdapterFactory("INSTAGRAM", null);
  setChannelAdapterFactory("TELEGRAM", null);
  setChannelAdapterFactory("WHATSAPP", null);
  setChannelAdapterFactory("TIKTOK", null);
});

function hmac(body: string, secret: string): string {
  return `sha256=${nodeCrypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

describe("P5 gate — concurrent auto-channel creation yields one row", () => {
  it("parallel first-contacts share a single auto channel (partial unique)", async () => {
    const base = {
      workspaceId: "ws-auto",
      channelType: "TELEGRAM",
      provider: "mock",
      type: "TEXT",
      text: "hi",
    } as const;
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
        processIncomingMessage(db as Db, {
          ...base,
          externalUserId: `tg-user-${i}`,
          externalConversationId: `tg-conv-${i}`,
          externalMessageId: `tg-m-${i}`,
          externalEventId: `tg-e-${i}`,
        })
      )
    );
    expect(new Set(results.map((r) => r.conversationId)).size).toBe(8);
    const autos = (db._stores.channel as any[]).filter(
      (c) => c.workspaceId === "ws-auto" && (c.externalId === undefined || c.externalId === null)
    );
    expect(autos).toHaveLength(1);
  });
});

describe("P5 adapter contract — capabilities are explicit, mock never silent", () => {
  it("capability matrix matches the documented provider surface", () => {
    expect(CHANNEL_CAPABILITIES.FACEBOOK.supportsComments).toBe(true);
    expect(CHANNEL_CAPABILITIES.FACEBOOK.supportsPrivateCommentReply).toBe(true);
    expect(CHANNEL_CAPABILITIES.INSTAGRAM.supportsComments).toBe(true);
    expect(CHANNEL_CAPABILITIES.TELEGRAM.supportsComments).toBe(false);
    // P9: approved-template sending is the official WhatsApp marketing path.
    expect(CHANNEL_CAPABILITIES.WHATSAPP.supportsTemplates).toBe(true);
    expect(CHANNEL_CAPABILITIES.TIKTOK.supportsMedia).toBe(false);
  });

  it("unsupported features throw instead of faking success", async () => {
    const tt = new TikTokChannelAdapter({ channelAccountId: "a" });
    await expect(tt.sendMedia("c", { type: "IMAGE", mediaUrl: "http://x/y.jpg" })).rejects.toMatchObject({
      code: "CHANNEL_FEATURE_UNSUPPORTED",
    });
    expect(ChannelFeatureError).toBeDefined();
  });

  it("unbound production resolution throws (never silent mock)", () => {
    expect(() => getChannelAdapter("INSTAGRAM")).toThrowError(ChannelNotSupportedError);
    expect(() => getChannelAdapter("TELEGRAM")).toThrowError(ChannelNotSupportedError);
    expect(() => getChannelAdapter("WHATSAPP")).toThrowError(ChannelNotSupportedError);
    expect(() => getChannelAdapter("TIKTOK")).toThrowError(ChannelNotSupportedError);
    expect(() => getChannelAdapter("WEB")).toThrowError(ChannelNotSupportedError);
  });

  it("all four adapters resolve through the registry with bindings", () => {
    const sender = async () => ({ messageId: "m1" });
    expect(
      getChannelAdapter("INSTAGRAM", { instagram: { igId: "ig1", channelAccountId: "a", sender } })
    ).toBeInstanceOf(InstagramChannelAdapter);
    expect(
      getChannelAdapter("TELEGRAM", { telegram: { channelAccountId: "a", sender } })
    ).toBeInstanceOf(TelegramChannelAdapter);
    expect(
      getChannelAdapter("WHATSAPP", { whatsapp: { phoneNumberId: "p", channelAccountId: "a", sender } })
    ).toBeInstanceOf(WhatsAppChannelAdapter);
    expect(getChannelAdapter("TIKTOK", { tiktok: { channelAccountId: "a", sender } })).toBeInstanceOf(
      TikTokChannelAdapter
    );
  });
});

describe("P5-B Instagram — normalize, verify, dedupe, policy", () => {
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "ig-acc-1",
        messaging: [
          { sender: { id: "igs-1" }, recipient: { id: "ig-acc-1" }, timestamp: 1720000000000, message: { mid: "ig-m-1", text: "مرحبا" } },
          { sender: { id: "ig-acc-1" }, recipient: { id: "igs-1" }, timestamp: 1720000001000, message: { mid: "ig-m-2", text: "echo", is_echo: true } },
        ],
      },
    ],
  };

  it("normalizes one inbound, drops echoes, scopes identity per account", () => {
    const a = new InstagramChannelAdapter({ igId: "ig-acc-1", channelAccountId: "a" });
    const msgs = a.receiveMessage(payload);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      channelType: "INSTAGRAM",
      externalUserId: "igs-1",
      externalMessageId: "ig-m-1",
      provider: "instagram",
      type: "TEXT",
      text: "مرحبا",
    });
    expect(deriveInstagramEventId(payload)).toBe("ig:ig-m-1|ig-m-2");
  });

  it("verifies the Meta HMAC scheme (accept/reject/empty)", () => {
    const body = JSON.stringify(payload);
    expect(verifyInstagramSignature(body, hmac(body, "s3"), "s3")).toBe(true);
    expect(verifyInstagramSignature(body, hmac(body, "nope"), "s3")).toBe(false);
    expect(verifyInstagramSignature(body, null, "s3")).toBe(false);
  });

  it("policy enforces connection, token and the 24h window", () => {
    expect(canSendInstagram({ channelStatus: "DISCONNECTED" }).allowed).toBe(false);
    expect(canSendInstagram({ channelStatus: "CONNECTED", tokenExpiresAt: new Date(Date.now() - 1000) }).allowed).toBe(false);
    expect(canSendInstagram({ channelStatus: "CONNECTED", lastCustomerMessageAt: new Date(Date.now() - 25 * 3600_000) })).toMatchObject({
      allowed: false,
    });
    expect(canSendInstagram({ channelStatus: "CONNECTED", lastCustomerMessageAt: new Date() }).allowed).toBe(true);
  });
});

describe("P5-C Telegram — normalize, secret verify, dedupe, policy", () => {
  const update = {
    update_id: 777,
    message: {
      message_id: 5,
      from: { id: 4242, first_name: "Layla", is_bot: false },
      chat: { id: 4242, type: "private" },
      date: 1720000000,
      text: "وين طلبي؟",
    },
  };

  it("normalizes private messages, drops bot echoes and empty updates", () => {
    const m = normalizeTelegramUpdate(update);
    expect(m).toMatchObject({
      externalCustomerId: "4242",
      externalConversationId: "4242",
      externalMessageId: "tg:4242:5",
      externalEventId: "tg:update:777",
      senderName: "Layla",
      text: "وين طلبي؟",
      mediaType: "TEXT",
    });
    expect(normalizeTelegramUpdate({ update_id: 1, message: { message_id: 2, from: { id: 9, is_bot: true }, chat: { id: 9, type: "private" }, date: 1 } })).toBeNull();
    expect(deriveTelegramEventId(update)).toBe("tg:update:777");
    const a = new TelegramChannelAdapter({ channelAccountId: "a" });
    expect(a.receiveMessage(update)).toHaveLength(1);
  });

  it("webhook secret uses exact timing-safe match (never HMAC here)", () => {
    expect(verifyTelegramWebhook("tok-abc", "tok-abc")).toBe(true);
    expect(verifyTelegramWebhook("tok-abd", "tok-abc")).toBe(false);
    expect(verifyTelegramWebhook(null, "tok-abc")).toBe(false);
    expect(verifyTelegramWebhook("tok-abc", null)).toBe(false);
    expect(verifyTelegramWebhook("", "")).toBe(false);
  });

  it("policy enforces connection and token validity (no window per docs)", () => {
    expect(canSendTelegram({ channelStatus: "DISCONNECTED", tokenValid: true })).toMatchObject({ allowed: false });
    expect(canSendTelegram({ channelStatus: "CONNECTED", tokenValid: false })).toMatchObject({ allowed: false });
    expect(canSendTelegram({ channelStatus: "CONNECTED", tokenValid: true }).allowed).toBe(true);
  });
});

describe("P5-D WhatsApp — normalize, verify, dedupe, policy", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555", phone_number_id: "num-1" },
              messages: [
                { from: "963930000001", id: "wamid.1", timestamp: "1720000000", type: "text", text: { body: "بكم التوصيل؟" } },
              ],
            },
          },
        ],
      },
    ],
  };

  it("normalizes by wa_id with per-message event identity", () => {
    const a = new WhatsAppChannelAdapter({ phoneNumberId: "num-1", channelAccountId: "a" });
    const msgs = a.receiveMessage(payload);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      channelType: "WHATSAPP",
      externalUserId: "963930000001",
      externalConversationId: "963930000001",
      externalMessageId: "wamid.1",
      provider: "whatsapp",
      type: "TEXT",
      text: "بكم التوصيل؟",
    });
    expect(msgs[0].externalEventId).toContain("wamid.1");
    expect(deriveWhatsAppEventId(payload)).toBe("wa:wamid.1");
  });

  it("status-only posts normalize to zero messages (acknowledged, not stored)", () => {
    const statuses = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "num-1" }, statuses: [{ id: "wamid.1", status: "read" }] } }] }],
    };
    const a = new WhatsAppChannelAdapter({ phoneNumberId: "num-1", channelAccountId: "a" });
    expect(a.receiveMessage(statuses)).toHaveLength(0);
  });

  it("verifies the Meta HMAC scheme", () => {
    const body = JSON.stringify(payload);
    expect(verifyWhatsAppSignature(body, hmac(body, "s3"), "s3")).toBe(true);
    expect(verifyWhatsAppSignature(body, "sha256=00", "s3")).toBe(false);
  });

  it("policy enforces window and names the template requirement outside it", () => {
    expect(canSendWhatsApp({ channelStatus: "CONNECTED", tokenValid: true, lastCustomerMessageAt: new Date() }).allowed).toBe(true);
    expect(
      canSendWhatsApp({ channelStatus: "CONNECTED", tokenValid: true, lastCustomerMessageAt: new Date(Date.now() - 25 * 3600_000) })
    ).toMatchObject({ allowed: false, reason: "WINDOW_CLOSED_TEMPLATE_REQUIRED" });
    expect(canSendWhatsApp({ channelStatus: "CONNECTED", tokenValid: true })).toMatchObject({
      allowed: false,
      reason: "WINDOW_CLOSED_TEMPLATE_REQUIRED",
    });
  });
});

describe("P5-E TikTok — local mapping only, explicit refusals", () => {
  const event = {
    event: "message",
    conversation_id: "tt-c-1",
    sender_id: "tt-u-9",
    sender_name: "Omar",
    message_id: "tt-m-3",
    text: "هل يوجد توصيل؟",
    timestamp: 1720000000,
  };

  it("maps the assumed shape, drops malformed payloads", () => {
    expect(normalizeTikTokEvent(event)).toMatchObject({
      externalCustomerId: "tt-u-9",
      externalConversationId: "tt-c-1",
      externalMessageId: "tt-m-3",
      text: "هل يوجد توصيل؟",
    });
    expect(normalizeTikTokEvent({})).toBeNull();
    expect(normalizeTikTokEvent({ conversation_id: "c" })).toBeNull();
    expect(deriveTikTokEventId(event)).toBe("tt:tt-c-1:tt-m-3");
  });

  it("interim secret verification refuses empty/mismatched secrets", () => {
    expect(verifyTikTokWebhook("s", "s")).toBe(true);
    expect(verifyTikTokWebhook("x", "s")).toBe(false);
    expect(verifyTikTokWebhook(null, "s")).toBe(false);
    expect(verifyTikTokWebhook("s", null)).toBe(false);
  });

  it("policy gates on approval + window, media refuses explicitly", async () => {
    expect(canSendTikTok({ channelStatus: "CONNECTED", accessApproved: false })).toMatchObject({
      allowed: false,
      reason: "ACCESS_NOT_APPROVED",
    });
    expect(canSendTikTok({ channelStatus: "CONNECTED", accessApproved: true, lastCustomerMessageAt: new Date() }).allowed).toBe(true);
    const a = new TikTokChannelAdapter({ channelAccountId: "a" });
    await expect(a.sendMedia("c", { type: "IMAGE", mediaUrl: "http://x/y" })).rejects.toMatchObject({
      code: "CHANNEL_FEATURE_UNSUPPORTED",
    });
  });
});
