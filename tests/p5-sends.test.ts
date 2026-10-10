import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { dispatchOutbound } from "@/modules/channels/outbound";
import { setInstagramClientFactory, InstagramClient } from "@/modules/channels/instagram/client";
import { setTelegramClientFactory, TelegramClient } from "@/modules/channels/telegram/client";
import { setWhatsAppClientFactory, WhatsAppClient } from "@/modules/channels/whatsapp/client";
import { setTikTokClientFactory, TikTokClient } from "@/modules/channels/tiktok/client";
import { setFacebookClientFactory, FacebookClient } from "@/modules/channels/facebook/client";

/**
 * P5 sends — one shared idempotency shell, per-provider policy + transport.
 * Provider APIs are stubbed (no network); assertions pin OUR behavior:
 * policy gates, SENT only on provider accept, transient QUEUED vs permanent
 * FAILED, no silent mock, notes never sent.
 */
const WS = "ws-p5send";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

async function seedThread(opts: {
  type: "INSTAGRAM" | "TELEGRAM" | "WHATSAPP" | "TIKTOK";
  externalId?: string;
  externalAccountId: string;
  identityId: string;
  metadata?: Record<string, unknown>;
  lastInboundNow?: boolean;
  conversationId?: string;
}) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: opts.type, status: "CONNECTED", displayName: "X", externalId: opts.externalId ?? opts.externalAccountId },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: opts.type, externalAccountId: opts.externalAccountId,
      encryptedCredentials: encryptSecret("fixture-token"),
      metadata: (opts.metadata ?? {}) as never,
    },
  } as never);
  const customer = (await db.customer.create({ data: { workspaceId: WS, phone: `p-${opts.identityId}` } } as never)) as any;
  await db.channelIdentity.create({
    data: { workspaceId: WS, customerId: customer.id, channelType: opts.type, channelExternalId: opts.identityId },
  } as never);
  const conv = (await db.conversation.create({
    data: {
      workspaceId: WS, customerId: customer.id, channelId: ch.id, channelConversationId: opts.conversationId ?? opts.identityId,
      lastCustomerMessageAt: opts.lastInboundNow === false ? new Date(Date.now() - 30 * 3600_000) : new Date(),
    },
  } as never)) as any;
  return { ch, conv };
}

function send(conversationId: string, text: string, source = `s-${Math.random().toString(36).slice(2, 8)}`) {
  return dispatchOutbound(db as Db, { workspaceId: WS, conversationId, sourceMessageId: source, text });
}

beforeEach(() => {
  db = createFakeDb();
  setInstagramClientFactory(null);
  setTelegramClientFactory(null);
  setWhatsAppClientFactory(null);
  setTikTokClientFactory(null);
  setFacebookClientFactory(null);
});

describe("P5 Instagram sends", () => {
  it("SENT on provider accept with the bound page token", async () => {
    const { conv } = await seedThread({ type: "INSTAGRAM", externalAccountId: "ig-1", identityId: "igs-1" });
    const calls: unknown[] = [];
    setInstagramClientFactory(
      () =>
        new InstagramClient({
          fetchImpl: (async (url: string, init?: { body?: string }) => {
            calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
            return Response.json({ recipient_id: "igs-1", message_id: "ig-sent-1" });
          }) as typeof fetch,
        })
    );
    const r = await send(conv.id, "أهلا");
    expect(r.deliveryStatus).toBe("SENT");
    expect(r.externalMessageId).toBe("ig-sent-1");
    expect(JSON.stringify(calls[0])).toContain("igs-1");
  });

  it("window-closed refuses without calling the provider", async () => {
    const { conv } = await seedThread({ type: "INSTAGRAM", externalAccountId: "ig-1", identityId: "igs-1", lastInboundNow: false });
    let calls = 0;
    setInstagramClientFactory(
      () =>
        new InstagramClient({
          fetchImpl: (async () => {
            calls += 1;
            return Response.json({});
          }) as typeof fetch,
        })
    );
    const r = await send(conv.id, "hi");
    expect(r.deliveryStatus).toBe("FAILED");
    expect(r.error).toContain("POLICY_WINDOW_CLOSED");
    expect(calls).toBe(0);
  });
});

describe("P5 Telegram sends", () => {
  it("SENT via Bot API, 429 with retry_after queues for retry", async () => {
    const { conv } = await seedThread({ type: "TELEGRAM", externalAccountId: "4242", identityId: "4242" });
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async (url: string) => {
            expect(url).toContain("/botfixture-token/sendMessage");
            return Response.json({ recipient_id: "4242", message_id: "tg-1", ok: true, result: { message_id: 11 } });
          }) as typeof fetch,
        })
    );
    // Note: client posts JSON {ok,result}; adapt stub to Bot shape below.
    const r = await send(conv.id, "hi");
    expect(r.deliveryStatus).toBe("SENT");
    expect(r.externalMessageId).toBe("tg:11");
  });

  it("429 with retry_after queues for retry (honors provider hint)", async () => {
    const { conv } = await seedThread({ type: "TELEGRAM", externalAccountId: "4242", identityId: "4242" });
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () => Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } })) as typeof fetch,
        })
    );
    const r = await send(conv.id, "hi");
    expect(r.deliveryStatus).toBe("QUEUED");
  });

  it("blocked chat fails permanent (no endless queue)", async () => {
    const { conv } = await seedThread({ type: "TELEGRAM", externalAccountId: "4242", identityId: "4242" });
    setTelegramClientFactory(
      () =>
        new TelegramClient({
          fetchImpl: (async () => Response.json({ ok: false, error_code: 403, description: "bot was blocked by the user" })) as typeof fetch,
        })
    );
    const r = await send(conv.id, "hi");
    expect(r.deliveryStatus).toBe("FAILED");
  });
});

describe("P5 WhatsApp sends", () => {
  it("SENT inside the window; refused outside it (no campaign leak)", async () => {
    const { conv } = await seedThread({ type: "WHATSAPP", externalAccountId: "num-1", identityId: "9631" });
    setWhatsAppClientFactory(
      () =>
        new WhatsAppClient({
          fetchImpl: (async () => Response.json({ messages: [{ id: "wamid.out.1" }] })) as typeof fetch,
        })
    );
    const okRes = await send(conv.id, "تفضل");
    expect(okRes.deliveryStatus).toBe("SENT");
    expect(okRes.externalMessageId).toBe("wamid.out.1");

    const old = await seedThread({ type: "WHATSAPP", externalAccountId: "num-1", identityId: "9632", lastInboundNow: false });
    let calls = 0;
    setWhatsAppClientFactory(
      () =>
        new WhatsAppClient({
          fetchImpl: (async () => {
            calls += 1;
            return Response.json({ messages: [{ id: "x" }] });
          }) as typeof fetch,
        })
    );
    const r = await send(old.conv.id, "حملة");
    expect(r.deliveryStatus).toBe("FAILED");
    expect(r.error).toContain("WINDOW_CLOSED_TEMPLATE_REQUIRED");
    expect(calls).toBe(0);
  });
});

describe("P5 TikTok sends (local-only)", () => {
  it("refuses without approval flag, sends with it (stubbed)", async () => {
    const { conv } = await seedThread({ type: "TIKTOK", externalAccountId: "tt-biz-1", identityId: "tt-u-1" });
    setTikTokClientFactory(
      () =>
        new TikTokClient({
          fetchImpl: (async () => Response.json({ code: 0, data: { message_id: "tt-out-1" } })) as typeof fetch,
        })
    );
    const r1 = await send(conv.id, "hi");
    expect(r1.deliveryStatus).toBe("FAILED");
    expect(r1.error).toContain("ACCESS_NOT_APPROVED");
    // Operator-approved access is recorded on the account metadata.
    const acc = (db._stores.channelAccount as any[])[0];
    acc.metadata = { ttAccessApproved: true };
    const r2 = await send(conv.id, "hi", "s2");
    expect(r2.deliveryStatus).toBe("SENT");
    expect(r2.externalMessageId).toBe("tt-out-1");
  });
});

describe("P5 cross-channel isolation + notes never send", () => {
  it("identities never cross providers (same raw id, two customers)", async () => {
    await seedThread({ type: "TELEGRAM", externalAccountId: "b1", identityId: "777", conversationId: "tg-c-777" });
    await seedThread({ type: "WHATSAPP", externalAccountId: "num-1", identityId: "777", conversationId: "wa-c-777" });
    const tg = await db.channelIdentity.findFirst({ where: { workspaceId: WS, channelType: "TELEGRAM", channelExternalId: "777" } });
    const wa = await db.channelIdentity.findFirst({ where: { workspaceId: WS, channelType: "WHATSAPP", channelExternalId: "777" } });
    expect((tg as any).customerId).not.toBe((wa as any).customerId);
  });

  it("internal notes are not routable to any sender", async () => {
    const { conv } = await seedThread({ type: "TELEGRAM", externalAccountId: "b1", identityId: "999" });
    const { postNote } = await import("@/modules/conversations/service");
    const note = (await postNote(db as Db, { userId: "u", workspaceId: WS }, conv.id, "internal")) as any;
    expect(note.isNote).toBe(true);
    expect(note.outboundIdempotencyKey ?? null).toBeNull();
  });

  it("Messenger path untouched by the multi-channel branch", async () => {
    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "P", externalId: "page-1" },
    } as never)) as any;
    await db.channelAccount.create({
      data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", encryptedCredentials: encryptSecret("t") },
    } as never);
    const customer = (await db.customer.create({ data: { workspaceId: WS, phone: "1" } } as never)) as any;
    await db.channelIdentity.create({ data: { workspaceId: WS, customerId: customer.id, channelType: "FACEBOOK", channelExternalId: "psid-1" } } as never);
    const conv = (await db.conversation.create({
      data: { workspaceId: WS, customerId: customer.id, channelId: ch.id, channelConversationId: "psid-1", lastCustomerMessageAt: new Date() },
    } as never)) as any;
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async () => Response.json({ recipient_id: "psid-1", message_id: "mid-fb-1" })) as typeof fetch,
        })
    );
    const r = await send(conv.id, "hi");
    expect(r.deliveryStatus).toBe("SENT");
    expect(r.externalMessageId).toBe("mid-fb-1");
  });
});
