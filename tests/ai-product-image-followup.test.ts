/**
 * THE PHOTO FOLLOWS THE PRODUCT — NOT ONLY THE WORDS OF ONE MESSAGE.
 *
 * «ورجيني الصورة» carries no product name. Before this test the resolver
 * only looked at the current message, so a follow-up after a product
 * conversation found no product and sent no image. The resolver now falls
 * back to the recent history, and a pure media request skips the
 * extraction model call (one less blocking round-trip).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { processIncomingMessage } from "@/modules/conversations/service";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { processAIMessage } from "@/modules/ai/orchestrator";

const WS = "ws-ai-product-image";
const PAGE = "page-ai-product-image";
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
  vi.stubEnv("APP_URL", "https://app.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
  setFacebookClientFactory(undefined as never);
  setMockAIProvider(undefined);
});

async function seedPage() {
  const ch = (await db.channel.create({
    data: {
      workspaceId: WS,
      type: "FACEBOOK",
      status: "CONNECTED",
      displayName: "صفحة الصور",
      externalId: PAGE,
    },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id,
      provider: "FACEBOOK",
      externalAccountId: PAGE,
      pageName: "صفحة الصور",
      encryptedCredentials: encryptSecret("page-token-images"),
    },
  } as never);
  return ch;
}

function facebookOk() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: any) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            let recipientId = "psid";
            try {
              recipientId = JSON.parse(String(init?.body ?? "{}"))?.recipient?.id ?? "psid";
            } catch {
              /* ignore */
            }
            return Response.json({ recipient_id: recipientId, message_id: `mid-${Date.now()}` });
          }
          return Response.json({ id: PAGE, name: "صفحة الصور" });
        }) as typeof fetch,
      })
  );
}

async function seedInbound(psid: string, text: string, channelId: string, tag: string) {
  return processIncomingMessage(db as Db, {
    workspaceId: WS,
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

const stubVector = { search: async () => [] } as never;

describe("AI product images — follow-up request", () => {
  it("sends the product photo when the customer asks after the product was already discussed", async () => {
    const ch = await seedPage();
    facebookOk();

    const product = (await db.product.create({
      data: {
        workspaceId: WS,
        name: "عطر الياسمين",
        sku: "SKU-JASMINE",
        price: 25,
        currency: "JOD",
      },
    } as never)) as any;
    const photo = (await db.mediaAsset.create({
      data: {
        workspaceId: WS,
        url: "https://cdn.example/jasmine.jpg",
        storageKey: "jasmine-photo",
        mimeType: "image/jpeg",
        size: 1200,
        type: "IMAGE",
        category: "PRODUCT",
        title: "عطر الياسمين",
      },
    } as never)) as any;
    await db.productMedia.create({
      data: { productId: product.id, mediaAssetId: photo.id, workspaceId: WS, sortOrder: 0 },
    } as never);

    const structuredCalls = { count: 0 };
    const systemSeen: string[] = [];
    const mock = new MockAIProvider();
    mock.intentHandler = () => {
      structuredCalls.count += 1;
      return {
        intent: "PRODUCT_QUESTION",
        confidence: 0.9,
        entities: {},
        missingFields: [],
        memories: [],
        requestedAction: "ANSWER",
      };
    };
    mock.responseHandler = (_user: string, system: string) => {
      systemSeen.push(system);
      return "تفضل الصورة 🌹";
    };
    setMockAIProvider(mock);

    // 1) The product is discussed and resolved from the customer's own words.
    const first = await seedInbound("psid-img-1", "بدي عطر الياسمين", ch.id, "img1");
    const firstRun = await processAIMessage(
      db as Db,
      { conversationId: first.conversationId, messageId: first.messageId, workspaceId: WS },
      { vectorStore: stubVector }
    );
    expect(firstRun.status).toBe("RESPONDED");
    expect(structuredCalls.count).toBe(1);

    // 2) The follow-up has no product name — history resolves it, and the
    //    extraction call is skipped for a pure media request.
    const second = await seedInbound("psid-img-1", "ورجيني الصورة", ch.id, "img2");
    const secondRun = await processAIMessage(
      db as Db,
      { conversationId: second.conversationId, messageId: second.messageId, workspaceId: WS },
      { vectorStore: stubVector }
    );
    expect(secondRun.status).toBe("RESPONDED");
    expect(structuredCalls.count).toBe(1);

    // The photo travelled with the reply, once.
    const outbound = await db.message.findMany({
      where: { conversationId: second.conversationId, direction: "OUTBOUND" },
      orderBy: { createdAt: "asc" },
    } as never);
    const withPhoto = outbound.filter((m: any) => m.metadata?.mediaId === photo.id);
    expect(withPhoto).toHaveLength(1);
    expect(withPhoto[0].deliveryStatus).toBe("SENT");

    // The model is told the system attaches the requested photo; it must not
    // apologise for being unable to send pictures.
    expect(systemSeen.at(-1)).toContain("لا تعتذر");
  });
});
