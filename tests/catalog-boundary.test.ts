/**
 * P18 — حدود كتالوج الصفحة.
 *
 * يثبت أن المنتج المحذوف من كتالوج الصفحة:
 *  - ما بينحلّ كمنتج للرد (allowlist)،
 *  - وأسئلته الجاهزة ما بتوصل لسياق الذكاء،
 *  - وتعليمات الرد بتحمل حدود الكتالوج صراحةً (حتى لا «يتذكّره» من المحادثة).
 *
 * ⚠️ قاعدة بالذاكرة ومزوّد وهمي — سلوك لا زمن إنتاج.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { createProduct } from "@/modules/products/service";
import { processIncomingMessage } from "@/modules/conversations/service";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { buildCatalogBoundary } from "@/modules/ai/catalog-boundary";
import { findMatchingFaqs } from "@/modules/knowledge/service";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;
const WS = "ws-catalog-boundary";
const AGENT = { userId: "agent-catalog", workspaceId: WS };

beforeEach(() => {
  setMockAIProvider(undefined);
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
});

describe("P18 — نص حدود الكتالوج", () => {
  it("كتالوج فاضي: منع أي ذكر لمنتج", () => {
    const text = buildCatalogBoundary([]);
    expect(text).toContain("لا توجد أي منتجات متاحة");
    expect(text).toContain("لا تذكر أي منتج");
  });

  it("كتالوج فيه منتجات: يسمّيها ويمنع ما عداها", () => {
    const text = buildCatalogBoundary(["ماء الكمأة", "عسل الكمأة"]);
    expect(text).toContain("ماء الكمأة");
    expect(text).toContain("عسل الكمأة");
    expect(text).toContain("أي منتج آخر");
    expect(text).toContain("غير متوفر");
  });

  it("يتجاهل الأسماء الفارغة ويحدّ العدد", () => {
    const text = buildCatalogBoundary(["", "  ", "منتج"]);
    expect(text).toContain("منتج");
    expect(text).not.toContain("، ،");
  });
});

describe("P18 — فلترة الأسئلة الجاهزة بحدود الكتالوج", () => {
  it("أسئلة المنتج المحذوف ما بترجع، والعام والمسموح بيرجعوا", async () => {
    const db = createFakeDb();
    const globalFaq = (await db.faq.create({
      data: { workspaceId: WS, question: "سعر المنتج العام؟", answer: "معلومة عامة", isActive: true },
    } as never)) as { id: string };
    const allowedFaq = (await db.faq.create({
      data: { workspaceId: WS, productId: "p-inside", question: "سعر المنتج المسموح", answer: "سعر المسموح 100", isActive: true },
    } as never)) as { id: string };
    const removedFaq = (await db.faq.create({
      data: { workspaceId: WS, productId: "p-removed", question: "سعر المنتج المحذوف", answer: "سعر المحذوف 987654", isActive: true },
    } as never)) as { id: string };

    const filtered = await findMatchingFaqs(db as unknown as Db, {
      workspaceId: WS,
      query: "سعر المنتج",
      allowedProductIds: ["p-inside"],
    });
    const ids = filtered.map((f) => f.id);
    expect(ids).toContain(globalFaq.id);
    expect(ids).toContain(allowedFaq.id);
    expect(ids).not.toContain(removedFaq.id);

    // كتالوج فاضي = أسئلة عامة فقط.
    const empty = await findMatchingFaqs(db as unknown as Db, {
      workspaceId: WS,
      query: "سعر المنتج",
      allowedProductIds: [],
    });
    expect(empty.map((f) => f.id)).toEqual([globalFaq.id]);

    // بلا كتالوجات (undefined) = السلوك القديم بلا تقييد.
    const legacy = await findMatchingFaqs(db as unknown as Db, {
      workspaceId: WS,
      query: "سعر المنتج",
    });
    expect(legacy.map((f) => f.id)).toContain(removedFaq.id);
  });
});

describe("P18 — الرد ما بيذكر منتجًا حُذف من الكتالوج", () => {
  it("سؤال عن منتج خارج الكتالوج: تعليمات الرد فيها الحدود وبلا حقائق المنتج المحذوف", async () => {
    const db = createFakeDb();
    const inside = await createProduct(db as unknown as Db, AGENT, {
      name: "ماء الكمأة",
      sku: "TW-500",
      price: 150000,
      currency: "SYP",
    });
    const removed = await createProduct(db as unknown as Db, AGENT, {
      name: "زيت الكمأة المحذوف",
      sku: "OIL-100",
      price: 90000,
      currency: "SYP",
    });
    const removedAnswer = "سعر زيت الكمأة المحذوف 987654 ل.س";
    await db.faq.create({
      data: {
        workspaceId: WS,
        productId: removed.id,
        question: "بكم زيت الكمأة المحذوف؟",
        answer: removedAnswer,
        isActive: true,
      },
    } as never);

    const ch = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "page-18", sendMode: "AUTO_REPLY" },
    } as never)) as { id: string };
    await db.channelAccount.create({
      data: {
        channelId: ch.id,
        provider: "FACEBOOK",
        externalAccountId: "page-18",
        pageName: "صفحة",
        encryptedCredentials: encryptSecret("tok-catalog"),
      },
    } as never);
    setFacebookClientFactory(
      () =>
        new FacebookClient({
          fetchImpl: (async (url: string) => {
            const u = new URL(url);
            if (u.pathname.includes("/messages")) {
              return Response.json({ recipient_id: "psid-18", message_id: `mid-${Date.now()}` });
            }
            return Response.json({ id: "p", name: "p" });
          }) as typeof fetch,
        })
    );
    const catalog = (await db.catalog.create({
      data: { workspaceId: WS, name: "كتالوج الصفحة", isActive: true },
    } as never)) as { id: string };
    await db.catalogPageAssignment.create({ data: { workspaceId: WS, catalogId: catalog.id, channelId: ch.id } } as never);
    await db.catalogProduct.create({ data: { catalogId: catalog.id, productId: inside.id } } as never);
    await db.aISettings.create({
      data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true },
    } as never);

    const inbound = await processIncomingMessage(db as unknown as Db, {
      workspaceId: WS,
      channelType: "FACEBOOK",
      channelId: ch.id,
      externalUserId: "psid-18",
      externalConversationId: "psid-18",
      externalMessageId: "m-18",
      externalEventId: "e-18",
      provider: "facebook",
      type: "TEXT",
      text: "بكم زيت الكمأة المحذوف؟",
    });

    const systemSeen: string[] = [];
    const mock = new MockAIProvider();
    mock.intentHandler = () => ({
      intent: "PRODUCT_QUESTION",
      confidence: 0.9,
      entities: {},
      missingFields: [],
      memories: [],
      requestedAction: "ANSWER",
    });
    mock.responseHandler = (_u: string, s: string) => {
      systemSeen.push(s);
      return "هذا المنتج غير متوفر حاليًا.";
    };
    setMockAIProvider(mock);

    const res = await processAIMessage(
      db as unknown as Db,
      { conversationId: inbound.conversationId, messageId: inbound.messageId, workspaceId: WS },
      { vectorStore: { size: 0, search: async () => [] } as never }
    );

    expect(res.status).not.toBe("AI_FAILED");
    const prompt = systemSeen.join("\n");
    // المنتج المحذوف ما بينحلّ (لا منتج بالسياق) → لا حقائق/سعر من الـFAQ.
    expect(prompt).toContain("حدود الكتالوج");
    expect(prompt).toContain(inside.name);
    expect(prompt).not.toContain("987654");
    expect(prompt).not.toContain(removedAnswer);
  });
});
