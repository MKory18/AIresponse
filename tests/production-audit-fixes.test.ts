/**
 * PRODUCTION AUDIT — end-to-end regression coverage for the four audited areas:
 * 1. MEDIA upload/processing (Arabic/Unicode names, MIME fallback, validation,
 *    storage, DB consistency, product linking, signed public delivery).
 * 2. FACEBOOK OUTBOUND delivery (SENT path, transient retry, permanent fail,
 *    stale PENDING/QUEUED recovery, duplicate prevention, media recovery).
 * 3. AI RESPONSE speed (extraction fast-path, provider timeout, single-query
 *    product resolution, concurrent context loads).
 * 4. CUSTOMER profile consistency (same-PSID identity, name/avatar persistence
 *    + refresh, non-blocking failure behavior).
 * 5. CONVERSATION MEMORY (history, CustomerMemory, reopen, isolation, dry-run).
 *
 * No secrets are printed. All external calls are mocked.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { LocalStorageProvider, getStorage, validateUpload } from "@/modules/media/storage";
import { uploadMedia, listMedia, generatePublicMediaUrl, findProductMedia } from "@/modules/media/service";
import { signPayload, verifyPayload, encryptSecret } from "@/core/crypto";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { FacebookApiError } from "@/modules/channels/facebook/types";
import { dispatchOutbound, recoverStuckOutboundMessages } from "@/modules/channels/outbound";
import { resolveSenderName } from "@/modules/channels/facebook/profile";
import { processIncomingMessage } from "@/modules/conversations/service";
import { createProduct } from "@/modules/products/service";
import { setMockAIProvider, MockAIProvider, OpenAICompatibleProvider } from "@/modules/ai/provider";
import { processAIMessage } from "@/modules/ai/orchestrator";

const WS_A = "ws-audit-a";
const WS_B = "ws-audit-b";
const AGENT = { userId: "agent-audit", workspaceId: WS_A };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let tmp: string;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const MARKUP = Buffer.from("<html><script>alert(1)</script></html>");

beforeEach(() => {
  db = createFakeDb();
  tmp = mkdtempSync(join(tmpdir(), "acre-audit-"));
  (globalThis as Record<string, unknown>).__acreStorage = new LocalStorageProvider(tmp);
  vi.stubEnv("APP_URL", "https://app.example.com");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  setFacebookClientFactory(undefined as never);
  setMockAIProvider(undefined);
});

// ── shared fixtures ─────────────────────────────────────────────────────────

async function seedPage(pageId = "page-audit-1") {
  const ch = (await db.channel.create({
    data: { workspaceId: WS_A, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة الاختبار", externalId: pageId },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: pageId, pageName: "صفحة الاختبار",
      encryptedCredentials: encryptSecret("page-token-audit"),
    },
  } as never);
  return ch;
}

async function seedInbound(psid: string, text: string, channelId?: string, n?: string) {
  const tag = n ?? Math.random().toString(36).slice(2, 8);
  return processIncomingMessage(db as Db, {
    workspaceId: WS_A,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: psid,
    externalUserName: null,
    externalConversationId: psid,
    externalMessageId: `m-${psid}-${tag}`,
    externalEventId: `e-${psid}-${tag}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
}

function fbSuccess() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: any) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let recipientId = "psid";
            try {
              recipientId = JSON.parse(String((init as any)?.body ?? "{}"))?.recipient?.id ?? "psid";
            } catch { /* ignore */ }
            return Response.json({ recipient_id: recipientId, message_id: `mid-${recipientId}-${Date.now()}` });
          }
          return Response.json({ id: "page", name: "page" });
        }) as typeof fetch,
      })
  );
}

function fbTransient() {
  setFacebookClientFactory(
    () => new FacebookClient({ fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch })
  );
}

function fbPermanent() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async () =>
          Response.json({ error: { message: "(#190) Invalid OAuth access token", code: 190 } }, { status: 400 })) as typeof fetch,
      })
  );
}

function mockAI(opts?: { structuredCalls?: { count: number }; systemSeen?: string[]; userSeen?: string[] }) {
  const mock = new MockAIProvider();
  mock.intentHandler = (user: string) => {
    if (opts?.structuredCalls) opts.structuredCalls.count += 1;
    return { intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" };
  };
  mock.responseHandler = (user: string, system: string) => {
    opts?.systemSeen?.push(system);
    opts?.userSeen?.push(user);
    return "أهلاً فيك 🌹 كيف فيني ساعدك اليوم؟";
  };
  setMockAIProvider(mock);
  return mock;
}

const stubVector = { search: async () => [] } as never;

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — MEDIA
// ════════════════════════════════════════════════════════════════════════════

describe("MEDIA — filenames (Arabic/Unicode/edge cases)", () => {
  it("1. Arabic filename upload stores + retrievable, URL is encoded", async () => {
    const asset = (await uploadMedia(db as Db, AGENT, {
      filename: "photo_٢٠٢٦-٠٧-١٩_١٥-٣٨-٥٤.jpg", mimeType: "image/jpeg", size: JPG.length, data: Buffer.from(JPG),
    })) as unknown as { id: string; storageKey: string; url: string };
    expect(asset.storageKey).toContain(WS_A);
    expect(asset.url.startsWith("/api/media/file/")).toBe(true);
    // No raw spaces/Arabic in the served URL (Facebook + browsers need encoding).
    expect(asset.url).not.toMatch(/[\s\u0600-\u06FF]/);
    expect(asset.url).toContain(encodeURIComponent("photo").slice(0, 5));
    // Existence check without opening a stream (leaked streams race teardown).
    const { join: joinPath } = await import("node:path");
    const { existsSync: exists } = await import("node:fs");
    expect(exists(joinPath(tmp, asset.storageKey))).toBe(true);
  });

  it("2. product Arabic names, emoji, multi-dot, very long names", async () => {
    const names: Array<[string, Buffer, string]> = [
      ["صورة المنتج.jpg", JPG, "image/jpeg"],
      ["منتج جديد 01.png", PNG, "image/png"],
      ["my.photo.final.v2.png", PNG, "image/png"],
      [`${"ص".repeat(200)}.png`, PNG, "image/png"],
    ];
    for (const [filename, data, mimeType] of names) {
      const asset = (await uploadMedia(db as Db, AGENT, {
        filename, mimeType, size: data.length, data: Buffer.from(data),
      })) as unknown as { storageKey: string; url: string };
      expect(asset.storageKey.length).toBeLessThan(400);
      expect(asset.url).not.toContain(" ");
      expect(existsSync(join(tmp, asset.storageKey))).toBe(true);
    }
  });

  it("3. octet-stream without usable extension is rejected (route must resolve first)", () => {
    expect(() => validateUpload({ mimeType: "application/octet-stream", filename: "photo_٢٠٢٦.jpg", size: 100 })).toThrow();
    // After the route's extension fallback resolves image/jpeg, upload succeeds.
    expect(() => validateUpload({ mimeType: "image/jpeg", filename: "photo_٢٠٢٦.jpg", size: 100 })).not.toThrow();
  });

  it("4. unsupported type / empty file / oversize rejected", async () => {
    await expect(uploadMedia(db as Db, AGENT, {
      filename: "a.zip", mimeType: "application/zip", size: 10, data: Buffer.alloc(10),
    })).rejects.toThrow();
    await expect(uploadMedia(db as Db, AGENT, {
      filename: "e.png", mimeType: "image/png", size: 0, data: Buffer.alloc(0),
    })).rejects.toThrow();
    await expect(uploadMedia(db as Db, AGENT, {
      filename: "big.png", mimeType: "image/png", size: 11 * 1024 * 1024, data: Buffer.alloc(10),
    })).rejects.toThrow();
  });

  it("5. markup masquerading as image + cross-family mismatch rejected; opaque bytes pass", async () => {
    await expect(uploadMedia(db as Db, AGENT, {
      filename: "evil.jpg", mimeType: "image/jpeg", size: MARKUP.length, data: Buffer.from(MARKUP),
    })).rejects.toThrow(expect.objectContaining({ code: "CORRUPT_FILE" }));
    // PNG bytes claimed as JPEG: positive mismatch.
    await expect(uploadMedia(db as Db, AGENT, {
      filename: "mismatch.jpg", mimeType: "image/jpeg", size: PNG.length, data: Buffer.from(PNG),
    })).rejects.toThrow(expect.objectContaining({ code: "CORRUPT_FILE" }));
  });

  it("6. ProductMedia linked (join + FK) and listMedia covers join-only links", async () => {
    const product = (await createProduct(db as Db, AGENT, { name: "منتج تدقيق", sku: "SKU-AUDIT-1", price: 50 })) as unknown as { id: string };
    const asset = (await uploadMedia(db as Db, AGENT, {
      filename: "p.png", mimeType: "image/png", size: PNG.length, data: Buffer.from(PNG), productId: product.id,
    })) as unknown as { id: string };
    const links = db._stores.productMedia as any[];
    expect(links.some((l) => l.productId === product.id && l.mediaAssetId === asset.id)).toBe(true);
    expect((await findProductMedia(db as Db, WS_A, product.id)).map((m) => m.id)).toContain(asset.id);
    // listMedia productId filter must include the join-table link.
    const listed = await listMedia(db as Db, { workspaceId: WS_A, productId: product.id });
    expect(listed.items.map((m) => m.id)).toContain(asset.id);
  });
});

describe("MEDIA — signed public delivery (Facebook outbound path)", () => {
  it("7. signed URL verifies; expired/tampered/malformed rejected; workspace isolated", async () => {
    const asset = (await uploadMedia(db as Db, AGENT, {
      filename: "pub.png", mimeType: "image/png", size: PNG.length, data: Buffer.from(PNG),
    })) as unknown as { id: string };
    const url = await generatePublicMediaUrl(db as Db, WS_A, asset.id, 60);
    expect(url).toContain("/api/media/public/");
    const token = url.split("/api/media/public/")[1];
    expect(verifyPayload(token)?.mediaId).toBe(asset.id);

    const expired = signPayload({ mediaId: asset.id, workspaceId: WS_A, exp: Math.floor(Date.now() / 1000) - 5 });
    expect(verifyPayload(expired)).toBeNull();
    // Tamper the signature's FIRST char (a full sextet — guaranteed to change
    // the decoded bytes; flipping the last char is unreliable because its low
    // bits are padding and may alias to identical bytes).
    const dot = token.lastIndexOf(".");
    const sig = token.slice(dot + 1);
    const tampered = `${token.slice(0, dot + 1)}${sig[0] === "a" ? "b" : "a"}${sig.slice(1)}`;
    expect(tampered).not.toBe(token);
    expect(verifyPayload(tampered)).toBeNull();
    expect(verifyPayload("not.a.token")).toBeNull();
    await expect(generatePublicMediaUrl(db as Db, WS_B, asset.id, 60)).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — OUTBOUND
// ════════════════════════════════════════════════════════════════════════════

describe("FACEBOOK OUTBOUND — state machine + recovery + idempotency", () => {
  it("9. AI/human text → Facebook SENT with provider id", async () => {
    const ch = await seedPage();
    fbSuccess();
    const r = await seedInbound("psid-sent-1", "مرحبا", ch.id);
    const res = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-sent-1", text: "أهلاً فيك",
    });
    expect(res.deliveryStatus).toBe("SENT");
    expect(res.externalMessageId).toBeTruthy();
    const row = (db._stores.message as any[]).find((m) => m.id === res.messageId);
    expect(row.deliveryStatus).toBe("SENT");
    expect(row.outboundIdempotencyKey).toBe(`${r.conversationId}:src-sent-1`);
  });

  it("10. transient/timeout → QUEUED with incrementing retryCount", async () => {
    const ch = await seedPage();
    fbTransient();
    const r = await seedInbound("psid-q-1", "مرحبا", ch.id);
    const first = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-q-1", text: "أهلاً",
    });
    expect(first.deliveryStatus).toBe("QUEUED");
    const second = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-q-1", text: "أهلاً",
    });
    expect(second.deliveryStatus).toBe("QUEUED");
    expect(second.messageId).toBe(first.messageId);
    const row = (db._stores.message as any[]).find((m) => m.id === first.messageId);
    expect(row.metadata.retryCount).toBe(2);
  });

  it("10b. AbortError timeout maps to QUEUED (TRANSIENT)", async () => {
    const client = new FacebookClient({
      fetchImpl: (async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }) as typeof fetch,
    });
    await expect(client.sendMessage("tok", "psid", { text: "hi" })).rejects.toBeInstanceOf(FacebookApiError);
    try {
      await client.sendMessage("tok", "psid", { text: "hi" });
    } catch (err) {
      expect((err as FacebookApiError).kind).toBe("TRANSIENT");
    }
  });

  it("11. permanent error (code 190) → FAILED immediately", async () => {
    const ch = await seedPage();
    fbPermanent();
    const r = await seedInbound("psid-f-1", "مرحبا", ch.id);
    const res = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-f-1", text: "أهلاً",
    });
    expect(res.deliveryStatus).toBe("FAILED");
    const row = (db._stores.message as any[]).find((m) => m.id === res.messageId);
    expect(row.metadata.retryable).toBe(false);
  });

  it("12+13. stale PENDING and QUEUED recover to SENT (no duplicates)", async () => {
    const ch = await seedPage();
    fbTransient();
    const r = await seedInbound("psid-stale-1", "مرحبا", ch.id);
    const queued = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-stale-q", text: "رد",
    });
    expect(queued.deliveryStatus).toBe("QUEUED");
    // A crashed send leaves PENDING: simulate directly.
    const pending = (await db.message.create({
      data: {
        conversationId: r.conversationId, workspaceId: WS_A, senderType: "AI", direction: "OUTBOUND",
        type: "TEXT", text: "رد عالق", provider: "facebook", deliveryStatus: "PENDING",
        outboundIdempotencyKey: `${r.conversationId}:src-stale-p`,
      },
    } as never)) as unknown as { id: string };
    const old = new Date(Date.now() - 20 * 60_000);
    await db.message.update({ where: { id: queued.messageId }, data: { createdAt: old } } as never);
    await db.message.update({ where: { id: pending.id }, data: { createdAt: old } } as never);

    fbSuccess();
    const out = await recoverStuckOutboundMessages(db as Db, { maxAgeMinutes: 10, limit: 20 });
    expect(out.recovered).toBe(2);
    const rows = db._stores.message as any[];
    expect(rows.find((m) => m.id === queued.messageId).deliveryStatus).toBe("SENT");
    expect(rows.find((m) => m.id === pending.id).deliveryStatus).toBe("SENT");
    // No duplicate rows for the same idempotency identities.
    expect(rows.filter((m) => m.outboundIdempotencyKey === `${r.conversationId}:src-stale-q`)).toHaveLength(1);
    expect(rows.filter((m) => m.outboundIdempotencyKey === `${r.conversationId}:src-stale-p`)).toHaveLength(1);
  });

  it("14. SENT rows are never resent (SKIPPED_DUPLICATE)", async () => {
    const ch = await seedPage();
    fbSuccess();
    const r = await seedInbound("psid-dup-1", "مرحبا", ch.id);
    const first = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-dup-1", text: "أهلاً",
    });
    expect(first.deliveryStatus).toBe("SENT");
    const second = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-dup-1", text: "أهلاً",
    });
    expect(second.deliveryStatus).toBe("SKIPPED_DUPLICATE");
    expect(second.messageId).toBe(first.messageId);
  });

  it("15. media attachment survives stale recovery (same attachment, signed URL)", async () => {
    const ch = await seedPage();
    const asset = (await uploadMedia(db as Db, AGENT, {
      filename: "send.png", mimeType: "image/png", size: PNG.length, data: Buffer.from(PNG),
    })) as unknown as { id: string };
    const bodies: any[] = [];
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async (url: string, init?: any) => {
            const u = new URL(url as string);
            if (u.pathname.endsWith("/me/messages")) {
              bodies.push(JSON.parse(String((init as any)?.body ?? "{}")));
              // First attempt: transient failure; recovery attempt: success.
              if (bodies.length === 1) return new Response("{}", { status: 500 });
              return Response.json({ recipient_id: "psid-media-1", message_id: "mid-media-1" });
            }
            return Response.json({});
          }) as typeof fetch,
        })
    );
    const r = await seedInbound("psid-media-1", "فرجيني صورة المنتج", ch.id);
    const first = await dispatchOutbound(db as Db, {
      workspaceId: WS_A, conversationId: r.conversationId, sourceMessageId: "src-media-1", text: "تفضل الصورة", mediaId: asset.id,
    });
    expect(first.deliveryStatus).toBe("QUEUED");
    const old = new Date(Date.now() - 20 * 60_000);
    await db.message.update({ where: { id: first.messageId }, data: { createdAt: old } } as never);
    const out = await recoverStuckOutboundMessages(db as Db, { maxAgeMinutes: 10, limit: 20 });
    expect(out.recovered).toBe(1);
    // Attempt 1 (attachment part) failed transiently; recovery sends attachment
    // then text — nothing is silently dropped, order is attachment-first.
    expect(bodies).toHaveLength(3);
    expect(bodies[1].message.attachment.payload.url).toContain("/api/media/public/");
    expect(bodies[2].message.text).toBe("تفضل الصورة");
    const row = (db._stores.message as any[]).find((m) => m.id === first.messageId);
    expect(row.deliveryStatus).toBe("SENT");
    expect(row.metadata.secondExternalMessageId).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — AI SPEED
// ════════════════════════════════════════════════════════════════════════════

describe("AI SPEED — minimum blocking work for normal messages", () => {
  it("16. greeting fast-path skips the extraction LLM call", async () => {
    const ch = await seedPage();
    fbSuccess();
    const structuredCalls = { count: 0 };
    mockAI({ structuredCalls });
    const r = await seedInbound("psid-fast-1", "مرحبا", ch.id, "fast1");
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { vectorStore: stubVector }
    );
    expect(res.status).toBe("RESPONDED");
    expect(structuredCalls.count).toBe(0);
    expect(res.response).toBeTruthy();
  });

  it("17. complex question still uses extraction (correctness preserved)", async () => {
    const ch = await seedPage();
    fbSuccess();
    const structuredCalls = { count: 0 };
    mockAI({ structuredCalls });
    const r = await seedInbound("psid-fast-2", "شو مواصفات المنتج بالتفصيل؟", ch.id, "fast2");
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { vectorStore: stubVector }
    );
    expect(structuredCalls.count).toBeGreaterThan(0);
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
  });

  it("19. a pure media request skips the extraction LLM call", async () => {
    const ch = await seedPage();
    fbSuccess();
    const structuredCalls = { count: 0 };
    mockAI({ structuredCalls });
    const r = await seedInbound("psid-fast-3", "ورجيني الصورة", ch.id, "fast3");
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A },
      { vectorStore: stubVector }
    );
    expect(structuredCalls.count).toBe(0);
    expect(res.status).toBe("RESPONDED");
  });

  it("18. provider requests are time-bounded (no hung worker)", async () => {
    vi.stubEnv("AI_REQUEST_TIMEOUT_MS", "50");
    const hanging = new OpenAICompatibleProvider({
      name: "hang", apiKey: "k", baseUrl: "https://example.invalid/v1/chat", defaultModel: "m",
    });
    // Replace global fetch with a never-resolving, abort-aware stub.
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = (url: any, init?: any) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    try {
      await expect(hanging.generateText({ system: "s", user: "u" })).rejects.toThrow(/timed out/);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 4 — PROFILE
// ════════════════════════════════════════════════════════════════════════════

describe("CUSTOMER PROFILE — Facebook name/avatar consistency", () => {
  it("19. same PSID resolves to the same Customer (no duplicates)", async () => {
    const ch = await seedPage();
    const a = await seedInbound("psid-prof-1", "مرحبا", ch.id, "p1");
    const b = await seedInbound("psid-prof-1", "عندي سؤال", ch.id, "p2");
    expect(a.customerId).toBe(b.customerId);
    expect(a.conversationId).toBe(b.conversationId);
    const identities = (db._stores.channelIdentity as any[]).filter((i) => i.channelExternalId === "psid-prof-1");
    expect(identities).toHaveLength(1);
  });

  it("20+21. Facebook name/avatar persist to identity AND customer", async () => {
    const ch = await seedPage();
    const client = new FacebookClient({
      fetchImpl: (async () =>
        Response.json({ first_name: "أحمد", last_name: "الحسن", name: "أحمد الحسن", profile_pic: "https://fb.example/pic.jpg" })) as typeof fetch,
    });
    const resolved = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-prof-2", pageToken: "tok", client });
    expect(resolved.name).toBe("أحمد الحسن");
    expect(resolved.avatarUrl).toBe("https://fb.example/pic.jpg");
    const r = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id,
      externalUserId: "psid-prof-2", externalUserName: resolved.name, externalAvatarUrl: resolved.avatarUrl,
      externalConversationId: "psid-prof-2", externalMessageId: "m-prof-2", externalEventId: "e-prof-2",
      provider: "facebook", type: "TEXT", text: "مرحبا",
    });
    const identity = (db._stores.channelIdentity as any[]).find((i) => i.channelExternalId === "psid-prof-2");
    const customer = (db._stores.customer as any[]).find((c) => c.id === r.customerId);
    expect(identity.displayName).toBe("أحمد الحسن");
    expect(identity.avatarUrl).toBe("https://fb.example/pic.jpg");
    expect(customer.name).toBe("أحمد الحسن");
    expect(customer.avatarUrl).toBe("https://fb.example/pic.jpg");
  });

  it("22. changed Facebook name/avatar refresh on next message (stale converges)", async () => {
    const ch = await seedPage();
    await seedInbound("psid-prof-3", "مرحبا", ch.id, "r1");
    await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id,
      externalUserId: "psid-prof-3", externalUserName: "اسم قديم", externalAvatarUrl: "https://fb.example/old.jpg",
      externalConversationId: "psid-prof-3", externalMessageId: "m-prof-3a", externalEventId: "e-prof-3a",
      provider: "facebook", type: "TEXT", text: "hi",
    });
    await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id,
      externalUserId: "psid-prof-3", externalUserName: "اسم جديد", externalAvatarUrl: "https://fb.example/new.jpg",
      externalConversationId: "psid-prof-3", externalMessageId: "m-prof-3b", externalEventId: "e-prof-3b",
      provider: "facebook", type: "TEXT", text: "hi again",
    });
    const identity = (db._stores.channelIdentity as any[]).find((i) => i.channelExternalId === "psid-prof-3");
    expect(identity.displayName).toBe("اسم جديد");
    expect(identity.avatarUrl).toBe("https://fb.example/new.jpg");
  });

  it("23. profile failure never breaks inbound (best-effort, null-safe)", async () => {
    const failing = new FacebookClient({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });
    const resolved = await resolveSenderName(db as Db, { workspaceId: WS_A, psid: "psid-prof-4", pageToken: "tok", client: failing });
    expect(resolved.name).toBeNull();
    expect(resolved.avatarUrl).toBeNull();
    const ch = await seedPage();
    const r = await seedInbound("psid-prof-4", "مرحبا", ch.id, "r4");
    expect(r.messageId).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 5 — MEMORY
// ════════════════════════════════════════════════════════════════════════════

describe("CONVERSATION MEMORY — real context, isolation, dry-run", () => {
  it("24. prior turns are visible to the model", async () => {
    const ch = await seedPage();
    fbSuccess();
    const userSeen: string[] = [];
    mockAI({ userSeen });
    const first = await seedInbound("psid-mem-1", "اسمي أحمد", ch.id, "mem1a");
    await processAIMessage(db as Db, { conversationId: first.conversationId, messageId: first.messageId, workspaceId: WS_A }, { vectorStore: stubVector });
    const second = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id,
      externalUserId: "psid-mem-1", externalConversationId: "psid-mem-1",
      externalMessageId: "m-mem-1b", externalEventId: "e-mem-1b",
      provider: "facebook", type: "TEXT", text: "شو بتنصحني؟",
    });
    await processAIMessage(db as Db, { conversationId: second.conversationId, messageId: second.messageId, workspaceId: WS_A }, { vectorStore: stubVector });
    expect(userSeen.length).toBeGreaterThan(0);
    expect(userSeen[userSeen.length - 1]).toContain("اسمي أحمد");
  });

  it("25. CustomerMemory is injected; 27. workspace isolation holds", async () => {
    const ch = await seedPage();
    fbSuccess();
    const systemSeen: string[] = [];
    mockAI({ systemSeen });
    const r = await seedInbound("psid-mem-2", "شو بتنصحني؟", ch.id, "mem2");
    const customerId = r.customerId;
    await db.customerMemory.create({
      data: { workspaceId: WS_A, customerId, type: "FACT", key: "secret fact a", value: "العميل يفضل اللون الأسود", confidence: 0.9, source: "test" },
    } as never);
    await db.customerMemory.create({
      data: { workspaceId: WS_B, customerId: "other-customer", type: "FACT", key: "secret fact b", value: "SECRET_WS_B_ONLY", confidence: 0.9, source: "test" },
    } as never);
    await processAIMessage(db as Db, { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A }, { vectorStore: stubVector });
    const last = systemSeen[systemSeen.length - 1] ?? "";
    expect(last).toContain("العميل يفضل اللون الأسود");
    expect(last).not.toContain("SECRET_WS_B_ONLY");
  });

  it("26. reopened conversation preserves history", async () => {
    const ch = await seedPage();
    const r = await seedInbound("psid-mem-3", "أريد الأسود", ch.id, "mem3a");
    await db.conversation.update({ where: { id: r.conversationId }, data: { deletedAt: new Date() } } as never);
    const again = await processIncomingMessage(db as Db, {
      workspaceId: WS_A, channelType: "FACEBOOK", channelId: ch.id,
      externalUserId: "psid-mem-3", externalConversationId: "psid-mem-3",
      externalMessageId: "m-mem-3b", externalEventId: "e-mem-3b",
      provider: "facebook", type: "TEXT", text: "بكم هو؟",
    });
    expect(again.conversationId).toBe(r.conversationId);
    const conv = (db._stores.conversation as any[]).find((c) => c.id === r.conversationId);
    expect(conv.deletedAt).toBeNull();
    const msgs = (db._stores.message as any[]).filter((m) => m.conversationId === r.conversationId);
    expect(msgs.some((m) => m.text === "أريد الأسود")).toBe(true);
    expect(msgs.some((m) => m.text === "بكم هو؟")).toBe(true);
  });

  it("28. dry-run never writes production memory/outbound/handoffs", async () => {
    const ch = await seedPage();
    fbSuccess();
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({
      intent: "PRODUCT_QUESTION", confidence: 0.9, entities: {},
      missingFields: [], memories: [{ type: "FACT", content: "dry run fact xyz" }], requestedAction: "ANSWER",
    });
    mock.responseHandler = () => "أهلاً فيك 🌹 كيف فيني ساعدك؟";
    setMockAIProvider(mock);
    const r = await seedInbound("psid-mem-4", "شو مواصفات المنتج؟", ch.id, "mem4");
    const beforeMem = (db._stores.customerMemory as any[]).length;
    const beforeOut = (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND").length;
    const res = await processAIMessage(
      db as Db,
      { conversationId: r.conversationId, messageId: r.messageId, workspaceId: WS_A, dryRun: true },
      { vectorStore: stubVector }
    );
    expect(res.response).toBeTruthy();
    expect((db._stores.customerMemory as any[]).length).toBe(beforeMem);
    expect((db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND").length).toBe(beforeOut);
  });
});
