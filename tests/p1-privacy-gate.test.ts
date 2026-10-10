import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { encryptSecret } from "@/core/crypto";
import type { AIProvider, AIResponse, StructuredRequest, TextRequest } from "@/modules/ai/provider";
import {
  PrivacyError,
  extractPhoneDeterministic,
  protectText,
  restoreText,
  scrubForEmbedding,
  sendProtectedStructured,
  sendProtectedText,
} from "@/modules/ai/privacy-gate";
import { validateResponse } from "@/modules/ai/guardrails";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { processIncomingMessage } from "@/modules/conversations/service";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { createProduct } from "@/modules/products/service";
import { InMemoryVectorStore } from "@/modules/knowledge/vector-store";

const WS = "ws-p1";
const AGENT = { userId: "agent-1", workspaceId: WS };
type Db = Prisma.TransactionClient;

const REAL_NAME = "أحمد الخالد";
const REAL_PHONE = "0930123456";
const REAL_ADDRESS = "دمشق المزة";
const REAL_EMAIL = "ahmad.k@example.com";
const HALLUCINATED_PHONE = "0999888777";

let db: ReturnType<typeof createFakeDb>;

/**
 * Fake EXTERNAL model: declares delivery="external" (traffic would leave our
 * infrastructure), records exactly what the gate handed it, and answers with
 * scripted payloads — including one hallucinated contact number.
 */
class RecordingExternalProvider implements AIProvider {
  readonly name = "recording-external";
  readonly delivery = "external" as const;
  captured: Array<{ kind: string; system: string; user: string }> = [];
  sendCalls = 0;

  async generateText(req: TextRequest): Promise<AIResponse> {
    this.sendCalls += 1;
    this.captured.push({ kind: "text", system: req.system, user: req.user });
    return {
      text: `يا [PII-1]، تم استلام طلبك. للطوارئ: ${HALLUCINATED_PHONE}.`,
      promptTokens: 10,
      completionTokens: 10,
      latencyMs: 1,
    };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<AIResponse & { value: T }> {
    this.sendCalls += 1;
    this.captured.push({ kind: "structured", system: req.system, user: req.user });
    const raw = {
      intent: "PRODUCT_QUESTION",
      confidence: 0.92,
      entities: {},
      missingFields: [],
      memories: [],
      requestedAction: "ANSWER",
    };
    const validated = req.validate(raw);
    if (!validated.ok) throw new Error(`fixture invalid: ${validated.error}`);
    return { text: JSON.stringify(raw), promptTokens: 10, completionTokens: 10, latencyMs: 1, value: validated.value };
  }
}

async function seedWorld() {
  db = createFakeDb();
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Demo Page", externalId: "page-1" },
  } as never)) as any;
  await db.channelAccount.create({
    data: {
      channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-1", pageName: "Demo Page",
      encryptedCredentials: encryptSecret("page-token-test"),
    },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          const u = new URL(url as string);
          if (u.pathname.endsWith("/me/messages")) {
            return Response.json({ recipient_id: "psid", message_id: "mid-psid" });
          }
          return Response.json({ id: "page-1", name: "Demo Page" });
        }) as typeof fetch,
      })
  );
  await db.aISettings.create({ data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500 } } as never);
  await createProduct(db as Db, AGENT, { name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP" });
  await db.persona.create({
    data: { workspaceId: WS, name: "سارة", dialect: "syrian", prohibitedPhrases: [], customRules: [] },
  } as never);
}

function emptyVectors(): InMemoryVectorStore {
  return new InMemoryVectorStore(new Map(), new Map());
}

beforeEach(async () => {
  await seedWorld();
});

describe("P1 privacy gate — unit (token vault, Arabic digits)", () => {
  it("round-trips known PII through per-call tokens (byte-identical restore)", () => {
    const src = `اسمي ${REAL_NAME} ورقمي ${REAL_PHONE} وعنواني ${REAL_ADDRESS} وبريدي ${REAL_EMAIL}`;
    const { text, vault } = protectText(src, { name: REAL_NAME, phone: REAL_PHONE, email: REAL_EMAIL, address: REAL_ADDRESS });
    expect(text).not.toContain(REAL_NAME);
    expect(text).not.toContain(REAL_PHONE);
    expect(text).not.toContain(REAL_ADDRESS);
    expect(text).not.toContain(REAL_EMAIL);
    expect(restoreText(text, vault)).toBe(src);
  });

  it("catches undeclared Arabic-Indic phone shapes without breaking prices", () => {
    const src = "رقمي ٠٩٣٠١٢٣٤٥٦ والسعر 150000 ليرة";
    const { text, vault } = protectText(src, {});
    expect(text).not.toContain("٠٩٣٠١٢٣٤٥٦");
    expect(text).toContain("150000");
    expect(restoreText(text, vault)).toBe(src);
  });

  it("extracts the deterministic phone from original text (Arabic digits)", () => {
    expect(extractPhoneDeterministic("كلمني على ٠٩٣٠١٢٣٤٥٦ بكرا")).toBe("0930123456");
    expect(extractPhoneDeterministic("السعر 150000 ليرة")).toBeNull();
  });

  it("scrubs embedding inputs consistently (phone/email gone, prices kept)", () => {
    const out = scrubForEmbedding(`رقمي ${REAL_PHONE} وبريدي ${REAL_EMAIL} والسعر 150000`);
    expect(out).not.toContain(REAL_PHONE);
    expect(out).not.toContain(REAL_EMAIL);
    expect(out).toContain("150000");
  });
});

describe("P1 privacy gate — external provider boundary (A/B/C/E/F/H)", () => {
  it("A/B/C: real name, phone and address never reach the external model; restored locally", async () => {
    const rec = new RecordingExternalProvider();
    const res = await sendProtectedText(
      rec,
      { system: "أنت مساعد مبيعات.", user: `اسمي ${REAL_NAME} ورقمي ${REAL_PHONE} وعنواني ${REAL_ADDRESS}` },
      { pii: { name: REAL_NAME, phone: REAL_PHONE, address: REAL_ADDRESS }, purpose: "TEST_ABC" }
    );
    expect(rec.sendCalls).toBe(1);
    const wire = `${rec.captured[0].system}\n${rec.captured[0].user}`;
    expect(wire).not.toContain(REAL_NAME);
    expect(wire).not.toContain(REAL_PHONE);
    expect(wire).not.toContain(REAL_ADDRESS);
    // Local restore brings trusted originals back; no token leaks out.
    expect(res.text).not.toContain("[PII-");
    expect(res.text).toContain("تم استلام طلبك");
  });

  it("E1: unknown provider delivery refuses without any external send", async () => {
    const shady = { name: "shady", generateText: async () => ({ text: "x", promptTokens: 0, completionTokens: 0, latencyMs: 0 }) } as unknown as AIProvider;
    await expect(sendProtectedText(shady, { system: "s", user: "u" }, { purpose: "TEST_E" })).rejects.toThrowError(PrivacyError);
  });

  it("E2: unmaskable input refuses without any external send", async () => {
    const rec = new RecordingExternalProvider();
    await expect(
      sendProtectedText(rec, { system: "s", user: 12345 as unknown as string }, { purpose: "TEST_E2" })
    ).rejects.toThrowError(PrivacyError);
    expect(rec.sendCalls).toBe(0);
  });

  it("F: two calls never share vaults (no cross-conversation restore)", async () => {
    const rec = new RecordingExternalProvider();
    const r1 = await sendProtectedText(rec, { system: "s", user: "أنا سارة ورقمي 0911111111" }, { pii: { name: "سارة", phone: "0911111111" }, purpose: "TEST_F" });
    const r2 = await sendProtectedText(rec, { system: "s", user: "أنا كريم ورقمي 0922222222" }, { pii: { name: "كريم", phone: "0922222222" }, purpose: "TEST_F" });
    // Canned reply echoes [PII-1] only (longest-known-first = the phone here):
    // each call restores ONLY its own vault — never the other call's data.
    expect(r1.text).toContain("0911111111");
    expect(r1.text).not.toContain("كريم");
    expect(r1.text).not.toContain("0922222222");
    expect(r2.text).toContain("0922222222");
    expect(r2.text).not.toContain("سارة");
    expect(r2.text).not.toContain("0911111111");
    expect(r1.text).not.toContain("[PII-");
    expect(r2.text).not.toContain("[PII-");
  });

  it("H1: hallucinated contact numbers are redacted, trusted ones restored", async () => {
    const rec = new RecordingExternalProvider();
    const res = await sendProtectedText(
      rec,
      { system: "s", user: `رقمي ${REAL_PHONE}` },
      { pii: { phone: REAL_PHONE }, trustedContacts: [REAL_PHONE], purpose: "TEST_H" }
    );
    expect(res.text).not.toContain(HALLUCINATED_PHONE);
    expect(res.text).toContain("[محجوب]");
  });

  it("H2: guardrail rejects invented contacts, accepts trusted ones", () => {
    const bad = validateResponse({ response: `كلمنا على ${HALLUCINATED_PHONE}`, trustedContacts: [REAL_PHONE] });
    expect(bad.valid).toBe(false);
    expect(bad.violations).toContain("UNVERIFIED_CONTACT");
    const good = validateResponse({ response: `سنتصل بك على ${REAL_PHONE}`, trustedContacts: [REAL_PHONE] });
    expect(good.violations).not.toContain("UNVERIFIED_CONTACT");
    // Legacy behavior preserved when the allowlist is omitted.
    const legacy = validateResponse({ response: `كلمنا على ${HALLUCINATED_PHONE}` });
    expect(legacy.violations).not.toContain("UNVERIFIED_CONTACT");
  });
});

describe("P1 privacy gate — full orchestrator wiring (D/G)", () => {
  async function inboundWithPII(text: string): Promise<string> {
    const result = await processIncomingMessage(db as Db, {
      workspaceId: WS,
      channelType: "FACEBOOK",
      externalUserId: "fb-user-p1",
      externalConversationId: "fb-conv-p1",
      externalMessageId: `fb-msg-p1-${Date.now()}`,
      externalEventId: `fb-evt-p1-${Date.now()}-${Math.random()}`,
      provider: "mock",
      type: "TEXT",
      text,
    });
    const conv = (await db.conversation.findUnique({ where: { id: result.conversationId } })) as any;
    await db.customer.update({
      where: { id: conv.customerId },
      data: { name: REAL_NAME, phone: REAL_PHONE, address: REAL_ADDRESS, email: REAL_EMAIL },
    });
    const msgs = (db._stores.message as any[]).filter((m) => m.direction === "INBOUND");
    return msgs[msgs.length - 1].id;
  }

  it("D: conversation context with PII flows masked end-to-end (extraction + response)", async () => {
    const messageId = await inboundWithPII(`مرحبا، اسمي ${REAL_NAME} ورقمي ${REAL_PHONE} وعنواني ${REAL_ADDRESS}، بكم ماء الكمأة؟`);
    const conv = (await db.conversation.findFirst({ where: { workspaceId: WS } })) as any;
    const rec = new RecordingExternalProvider();
    const result = await processAIMessage(
      db as Db,
      { workspaceId: WS, conversationId: conv.id, messageId },
      { provider: rec, vectorStore: emptyVectors() }
    );
    expect(["RESPONDED", "CLARIFIED"]).toContain(result.status);
    expect(rec.captured.length).toBeGreaterThanOrEqual(2);
    for (const c of rec.captured) {
      const wire = `${c.system}\n${c.user}`;
      expect(wire).not.toContain(REAL_NAME);
      expect(wire).not.toContain(REAL_PHONE);
      expect(wire).not.toContain(REAL_ADDRESS);
      expect(wire).not.toContain(REAL_EMAIL);
    }
    // Model-hallucinated number never reaches the customer.
    expect(result.response).not.toContain(HALLUCINATED_PHONE);
  });

  it("G: gate refusal leaves no customer data in usage logs or handoff records", async () => {
    const messageId = await inboundWithPII(`مرحبا، اسمي ${REAL_NAME} ورقمي ${REAL_PHONE}، بكم ماء الكمأة؟`);
    const conv = (await db.conversation.findFirst({ where: { workspaceId: WS } })) as any;
    const shady = {
      name: "shady-external",
      generateText: async () => ({ text: "x", promptTokens: 0, completionTokens: 0, latencyMs: 0 }),
      generateStructured: async () => ({ text: "{}", promptTokens: 0, completionTokens: 0, latencyMs: 0, value: {} }),
    } as unknown as AIProvider;
    const result = await processAIMessage(db as Db, { workspaceId: WS, conversationId: conv.id, messageId }, { provider: shady, vectorStore: emptyVectors() });
    expect(result.status).toBe("AI_FAILED");
    const usageRows = db._stores.aIUsageLog as any[];
    expect(usageRows.length).toBeGreaterThan(0);
    for (const row of usageRows) {
      const blob = JSON.stringify(row);
      expect(blob).not.toContain(REAL_NAME);
      expect(blob).not.toContain(REAL_PHONE);
      expect(blob).not.toContain(REAL_ADDRESS);
      expect(blob).not.toContain(REAL_EMAIL);
    }
    const handoffs = db._stores.humanHandoff as any[];
    for (const h of handoffs) {
      const blob = JSON.stringify(h);
      expect(blob).not.toContain(REAL_NAME);
      expect(blob).not.toContain(REAL_PHONE);
      expect(blob).not.toContain(REAL_ADDRESS);
    }
  });
});
