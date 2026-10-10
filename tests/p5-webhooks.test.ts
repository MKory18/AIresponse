import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { ingestInstagramWebhook } from "@/modules/channels/instagram/webhook";
import { ingestTelegramWebhook } from "@/modules/channels/telegram/webhook";
import { ingestWhatsAppWebhook } from "@/modules/channels/whatsapp/webhook";
import { ingestTikTokWebhook } from "@/modules/channels/tiktok/webhook";
import { ingestTikTokWebhook } from "@/modules/channels/tiktok/webhook";
import nodeCrypto from "node:crypto";

/**
 * P5 webhooks — verification, routing, idempotency, isolation per channel.
 * No network, no real credentials (fixture tokens only).
 */
const WS = "ws-p5wh";
const OTHER = "ws-p5wh-other";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

async function seedAccount(opts: {
  provider: string;
  externalAccountId: string;
  channelType: string;
  externalId?: string;
  workspaceId?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}) {
  const ws = opts.workspaceId ?? WS;
  const ch = (await db.channel.create({
    data: { workspaceId: ws, type: opts.channelType, status: opts.status ?? "CONNECTED", displayName: "X", externalId: opts.externalId ?? opts.externalAccountId },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: opts.provider, externalAccountId: opts.externalAccountId,
      encryptedCredentials: encryptSecret("fixture-token"),
      metadata: (opts.metadata ?? {}) as never,
    },
  } as never);
  return ch;
}

function metaHmac(body: string, secret: string): string {
  return `sha256=${nodeCrypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

beforeEach(() => {
  db = createFakeDb();
});

describe("P5 Instagram webhook", () => {
  const payload = {
    object: "instagram",
    entry: [{ id: "ig-1", messaging: [{ sender: { id: "igs-9" }, recipient: { id: "ig-1" }, timestamp: 1720000000000, message: { mid: "ig-m-9", text: "سلام" } }] }],
  };

  it("ingests, dedupes replays, rejects unknown accounts", async () => {
    await seedAccount({ provider: "INSTAGRAM", externalAccountId: "ig-1", channelType: "INSTAGRAM" });
    const r1 = await ingestInstagramWebhook(db as Db, payload);
    expect(r1.status).toBe("OK");
    expect(r1.normalizedCount).toBe(1);
    const r2 = await ingestInstagramWebhook(db as Db, payload);
    expect(r2.status).toBe("DUPLICATE");
    expect((db._stores.webhookEvent as any[]).filter((w) => w.source === "instagram")).toHaveLength(1);
  });

  it("ignores non-instagram objects without side effects", async () => {
    const r = await ingestInstagramWebhook(db as Db, { object: "page", entry: [] });
    expect(r.status).toBe("NON_INSTAGRAM_OBJECT");
    expect((db._stores.webhookEvent as any[])).toHaveLength(0);
  });

  it("unknown accounts 404 without side effects (routing is globally unique per account)", async () => {
    const r = await ingestInstagramWebhook(db as Db, {
      object: "instagram",
      entry: [{ id: "ig-ghost", messaging: [{ sender: { id: "s" }, recipient: { id: "ig-ghost" }, timestamp: 1, message: { mid: "m", text: "hi" } }] }],
    });
    expect(r.status).toBe("UNKNOWN_ACCOUNT");
    expect((db._stores.webhookEvent as any[])).toHaveLength(0);
  });
});

describe("P5 Telegram webhook", () => {
  const update = {
    update_id: 4242,
    message: { message_id: 7, from: { id: 555, first_name: "Sara" }, chat: { id: 555, type: "private" }, date: 1720000000, text: "مرحبا" },
  };

  it("accepts the registered secret, dedupes update_id, rejects impostors", async () => {
    await seedAccount({ provider: "TELEGRAM", externalAccountId: "424242", channelType: "TELEGRAM", metadata: { tgWebhookSecret: "s3cr3t" } });
    const ok = await ingestTelegramWebhook(db as Db, update, "s3cr3t");
    expect(ok.status).toBe("OK");
    expect(ok.normalizedCount).toBe(1);
    const dup = await ingestTelegramWebhook(db as Db, update, "s3cr3t");
    expect(dup.status).toBe("DUPLICATE");
    const bad = await ingestTelegramWebhook(db as Db, update, "wrong");
    expect(bad.status).toBe("INVALID_SECRET");
    const missing = await ingestTelegramWebhook(db as Db, update, null);
    expect(missing.status).toBe("INVALID_SECRET");
    expect((db._stores.webhookEvent as any[]).filter((w) => w.source === "telegram")).toHaveLength(1);
  });
});

describe("P5 WhatsApp webhook", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "1555", phone_number_id: "num-9" },
          messages: [{ from: "963930000009", id: "wamid.9", timestamp: "1720000000", type: "text", text: { body: "تم" } }],
        },
      }],
    }],
  };

  it("ingests by wa_id, dedupes wamid, acks statuses-only posts", async () => {
    await seedAccount({ provider: "WHATSAPP", externalAccountId: "num-9", channelType: "WHATSAPP" });
    const r1 = await ingestWhatsAppWebhook(db as Db, payload);
    expect(r1.status).toBe("OK");
    expect(r1.normalizedCount).toBe(1);
    expect(await ingestWhatsAppWebhook(db as Db, payload)).toMatchObject({ status: "DUPLICATE" });
    const statuses = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "num-9" }, statuses: [{ id: "wamid.9", status: "read" }] } }] }],
    };
    const s = await ingestWhatsAppWebhook(db as Db, statuses);
    expect(s.status).toBe("OK");
    expect(s.normalizedCount).toBe(0);
  });

  it("rejects unknown numbers without side effects", async () => {
    const r = await ingestWhatsAppWebhook(db as Db, payload);
    expect(r.status).toBe("UNKNOWN_NUMBER");
    expect((db._stores.webhookEvent as any[])).toHaveLength(0);
  });
});

describe("P5 TikTok webhook (local-only)", () => {
  const event = { event: "message", conversation_id: "tt-c-1", sender_id: "tt-u-1", message_id: "tt-m-1", text: "hi", timestamp: 1720000000 };

  it("accepts configured secret + account, dedupes, rejects others", async () => {
    await seedAccount({ provider: "TIKTOK", externalAccountId: "tt-biz-1", channelType: "TIKTOK", metadata: { ttWebhookSecret: "tt-s" } });
    expect(await ingestTikTokWebhook(db as Db, event, "tt-s", "tt-biz-1")).toMatchObject({ status: "OK" });
    expect(await ingestTikTokWebhook(db as Db, event, "tt-s", "tt-biz-1")).toMatchObject({ status: "DUPLICATE" });
    expect(await ingestTikTokWebhook(db as Db, event, "nope", "tt-biz-1")).toMatchObject({ status: "INVALID_SECRET" });
    expect(await ingestTikTokWebhook(db as Db, event, "tt-s", "unknown")).toMatchObject({ status: "UNKNOWN_ACCOUNT" });
  });
});

describe("P5 Meta signature helper reuse", () => {
  it("instagram/whatsapp HMAC helpers mirror the Meta scheme", async () => {
    const { verifyInstagramSignature } = await import("@/modules/channels/instagram/normalizer");
    const { verifyWhatsAppSignature } = await import("@/modules/channels/whatsapp/normalizer");
    const body = JSON.stringify({ a: 1 });
    expect(verifyInstagramSignature(body, metaHmac(body, "k"), "k")).toBe(true);
    expect(verifyWhatsAppSignature(body, metaHmac(body, "k"), "k")).toBe(true);
    expect(verifyInstagramSignature(body, "sha256=00", "k")).toBe(false);
  });
});
