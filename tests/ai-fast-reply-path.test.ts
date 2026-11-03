/**
 * Fast reply path — short small-talk must not pay an extraction round-trip.
 *
 * Proves:
 *  - A short message with no order/business signal skips the extraction LLM
 *    call entirely (response still generated and sent).
 *  - A message with a business signal (price/product/number) still runs the
 *    extraction call — the fast path never guesses orders.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

const WS = "ws-fast-reply";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
const stubVector = { search: async () => [] } as never;

beforeEach(() => {
  db = createFakeDb();
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
});

function fbSuccess() {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          const u = new URL(url);
          if (u.pathname.endsWith("/me/messages")) {
            return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` });
          }
          return Response.json({ id: "p", name: "p" });
        }) as typeof fetch,
      })
  );
}

async function seedPage() {
  const ch = (await db.channel.create({
    data: {
      workspaceId: WS,
      type: "FACEBOOK",
      status: "CONNECTED",
      displayName: "Fast Page",
      externalId: "page-fast-1",
    },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id,
      provider: "FACEBOOK",
      externalAccountId: "page-fast-1",
      pageName: "Fast Page",
      encryptedCredentials: encryptSecret("page-token-fast"),
    },
  } as never);
  return ch;
}

async function runMessage(channelId: string, text: string, suffix: string) {
  const incoming = await processIncomingMessage(db as Db, {
    workspaceId: WS,
    channelType: "FACEBOOK",
    channelId,
    externalUserId: "psid-fast",
    externalConversationId: "psid-fast",
    externalMessageId: `m-fast-${suffix}`,
    externalEventId: `e-fast-${suffix}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
  const res = await processAIMessage(
    db as Db,
    { conversationId: incoming.conversationId, messageId: incoming.messageId, workspaceId: WS },
    { vectorStore: stubVector }
  );
  return res;
}

describe("extraction fast path", () => {
  it("رسالة قصيرة بلا إشارة عمل: صفر نداء استخراج + رد فعلي", async () => {
    const ch = await seedPage();
    fbSuccess();
    const mock = new MockAIProvider();
    let intentCalls = 0;
    mock.intentHandler = () => {
      intentCalls += 1;
      return {
        intent: "UNKNOWN",
        confidence: 0.3,
        entities: {},
        missingFields: [],
        memories: [],
        requestedAction: "ANSWER",
      };
    };
    mock.responseHandler = () => "على راسي 🌹";
    setMockAIProvider(mock);

    const res = await runMessage(ch.id, "شكرا 🌹", "small-talk");

    expect(intentCalls).toBe(0);
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
    const out = (db._stores.message as any[]).filter(
      (m) => m.conversationId && m.direction === "OUTBOUND" && m.senderType === "AI"
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1].text).toContain("على راسي");
  });

  it("سؤال سعر: الاستخراج يشتغل عادي (ما في تخمين)", async () => {
    const ch = await seedPage();
    fbSuccess();
    const mock = new MockAIProvider();
    let intentCalls = 0;
    mock.intentHandler = () => {
      intentCalls += 1;
      return {
        intent: "PRICE_QUESTION",
        confidence: 0.9,
        entities: {},
        missingFields: [],
        memories: [],
        requestedAction: "ANSWER",
      };
    };
    mock.responseHandler = () => "السعر حسب الكتالوج";
    setMockAIProvider(mock);

    const res = await runMessage(ch.id, "بكم سعر المنتج؟", "price");

    expect(intentCalls).toBe(1);
    expect(["RESPONDED", "CLARIFIED"]).toContain(res.status);
  });

  it("رسالة فيها رقم: ما بتتخطى الاستخراج", async () => {
    const ch = await seedPage();
    fbSuccess();
    const mock = new MockAIProvider();
    let intentCalls = 0;
    mock.intentHandler = () => {
      intentCalls += 1;
      return {
        intent: "UNKNOWN",
        confidence: 0.4,
        entities: {},
        missingFields: [],
        memories: [],
        requestedAction: "ANSWER",
      };
    };
    mock.responseHandler = () => "تمام";
    setMockAIProvider(mock);

    await runMessage(ch.id, "بدي 2 حبة", "digits");

    expect(intentCalls).toBe(1);
  });
});
