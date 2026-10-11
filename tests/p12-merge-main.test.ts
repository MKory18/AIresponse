import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { MockAIProvider, setMockAIProvider } from "@/modules/ai/provider";
import { processAIMessage } from "@/modules/ai/orchestrator";
import { processIncomingMessage } from "@/modules/conversations/service";
import { createProduct } from "@/modules/products/service";
import { createPlaygroundSession, sendPlaygroundMessage } from "@/modules/ai/playground-service";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";
import { readFileSync } from "node:fs";
import { SYSTEM_SPECS, TOKEN_PRESETS } from "@/modules/integrations/systems";

/**
 * P12 × main (وضع Hermes للشخصية الخارجية) — دمج دلالي:
 * قواعد الامتثال من سيستم 1 (المسموح · الممنوع) لازم توصل للموديل بكل مسار
 * بيكتب رد: مسار الرد العادي (كان مغطّى) · مسار Hermes الجديد بالـ main ·
 * والتجربة اليدوية (playground) بالمسارين — وإلا الحارس بيرفض ردود الموديل
 * ما كان بيعرف إنها ممنوعة (فشل بلا داعي)، أو التجربة بتختلف عن الإنتاج.
 */

type Db = Prisma.TransactionClient;
type Row = Record<string, any>;
const WS = "ws-p12-merge";
const ctx = { userId: "agent-merge", workspaceId: WS };
const HERMES_BASE = "http://127.0.0.1:8642/v1";
const HERMES_KEY = "zz-merge-hermes-key-77";
const BANNED = "نتيجة مضمونة";
const ALLOWED = "مكونات طبيعية";

let db: ReturnType<typeof createFakeDb>;
let calls: { system: string; user: string }[] = [];
let reply = "أهلين فيك، ماء الكمأة بمكونات طبيعية 🌹";
const origFetch = globalThis.fetch;
let prevEnv: Record<string, string | undefined>;

function okChat(text: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
}

function stubHermesFetch() {
  (globalThis as { fetch: unknown }).fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const system = String(body?.messages?.[0]?.content ?? "");
    const user = String(body?.messages?.[body.messages.length - 1]?.content ?? "");
    calls.push({ system, user });
    if (system.includes("JSON")) {
      return okChat(JSON.stringify({ intent: "PRICE_QUESTION", confidence: 0.9, entities: {}, missingFields: [], memories: [], requestedAction: "ANSWER" }));
    }
    return okChat(reply);
  };
}

async function seedProductWithRules(): Promise<Row> {
  const p = (await createProduct(db as Db, ctx, { name: "ماء الكمأة", sku: "TW-M1", price: 150000, currency: "SYP", stockStatus: "IN_STOCK", isActive: true } as never)) as Row;
  (db._stores.productCompliance as Row[]).push({
    id: "pc-merge", workspaceId: WS, productId: p.id, productRef: "pf_m1", verdict: "restricted",
    allowedClaims: [ALLOWED], bannedClaims: [BANNED], adRules: [], fetchedAt: new Date(),
  });
  return p;
}

async function seedChannel() {
  const ch = (await db.channel.create({ data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Page", externalId: "page-merge" } } as never)) as Row;
  await db.channelAccount.create({
    data: { channelId: ch.id, provider: "FACEBOOK", externalAccountId: "page-merge", pageName: "Page", encryptedCredentials: encryptSecret("page-token") },
  } as never);
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          if (new URL(String(url)).pathname.endsWith("/me/messages")) {
            const to = JSON.parse(String(init?.body ?? "{}"))?.recipient?.id ?? "psid";
            return Response.json({ recipient_id: to, message_id: `mid-${to}` });
          }
          return Response.json({ id: "page-merge", name: "Page" });
        }) as unknown as typeof fetch,
      })
  );
}

const replySystems = () => calls.filter((c) => !c.system.includes("JSON")).map((c) => c.system);
const outbound = () => (db._stores.message as Row[]).filter((m) => m.direction === "OUTBOUND");

beforeEach(async () => {
  db = createFakeDb();
  (db._stores.workspaceMember as Row[]).push({ id: "m-merge", workspaceId: WS, userId: ctx.userId, status: "ACTIVE" });
  prevEnv = { HERMES_BASE_URL: process.env.HERMES_BASE_URL, HERMES_API_KEY: process.env.HERMES_API_KEY, HERMES_MODEL: process.env.HERMES_MODEL };
  process.env.HERMES_BASE_URL = HERMES_BASE;
  process.env.HERMES_API_KEY = HERMES_KEY;
  delete process.env.HERMES_MODEL;
  setMockAIProvider(undefined);
  calls = [];
  reply = "أهلين فيك، ماء الكمأة بمكونات طبيعية 🌹";
});

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = origFetch;
  setMockAIProvider(undefined);
  setFacebookClientFactory(null as never);
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("P12 × main — قواعد سيستم 1 بمسار Hermes للرد", () => {
  beforeEach(async () => {
    stubHermesFetch();
    await db.aISettings.create({ data: { workspaceId: WS, provider: "hermes", responseModel: "hermes-agent", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true } } as never);
    await seedChannel();
    await seedProductWithRules();
  });

  async function run(text: string, suffix: string) {
    const r = await processIncomingMessage(db as Db, {
      workspaceId: WS, channelType: "FACEBOOK", externalUserId: `fb-u-${suffix}`, externalConversationId: `fb-c-${suffix}`,
      externalMessageId: `fb-m-${suffix}`, externalEventId: `fb-e-${suffix}`, provider: "mock", type: "TEXT", text,
    });
    return processAIMessage(db as Db, { workspaceId: WS, conversationId: r.conversationId, messageId: r.messageId }, { vectorStore: { search: async () => [] } as never });
  }

  it("المسموح والممنوع بيوصلوا لـ Hermes مع البيانات الموثوقة", async () => {
    const res = await run("مرحبا، بكم ماء الكمأة؟", "a");
    expect(res.status).toBe("RESPONDED");
    const systems = replySystems();
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]).toContain(BANNED);
    expect(systems[0]).toContain(ALLOWED);
  });

  it("رد Hermes بادعاء ممنوع = ما بينبعت للزبون (الحارس شغّال بوضع Hermes)", async () => {
    reply = "ماء الكمأة نتيجه مضمونه من أول أسبوع";
    const res = await run("مرحبا، بكم ماء الكمأة لو سمحت؟", "b");
    expect(res.status).toBe("AI_FAILED");
    expect(outbound()).toHaveLength(0);
  });
});

describe("P12 × main — قواعد سيستم 1 بالتجربة اليدوية (playground)", () => {
  it("المسار العادي: القواعد بموجّه النظام متل الإنتاج", async () => {
    const mock = new MockAIProvider();
    const systems: string[] = [];
    mock.responseHandler = (_user, system) => {
      systems.push(system);
      return "ماء الكمأة بمكونات طبيعية";
    };
    setMockAIProvider(mock);
    await db.aISettings.create({ data: { workspaceId: WS, provider: "mock", temperature: 0.4, maxTokens: 500 } } as never);
    const p = await seedProductWithRules();
    const s = (await createPlaygroundSession(db as Db, ctx, { productId: p.id, useKnowledge: false })) as Row;
    await sendPlaygroundMessage(db as Db, ctx, s.id, "بكم ماء الكمأة؟");
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]).toContain(BANNED);
    expect(systems[0]).toContain(ALLOWED);
  });

  it("مسار Hermes: القواعد بموجّه النظام متل الإنتاج", async () => {
    stubHermesFetch();
    await db.aISettings.create({ data: { workspaceId: WS, provider: "hermes", responseModel: "hermes-agent", temperature: 0.4, maxTokens: 500 } } as never);
    const p = await seedProductWithRules();
    const s = (await createPlaygroundSession(db as Db, ctx, { productId: p.id, useKnowledge: false })) as Row;
    await sendPlaygroundMessage(db as Db, ctx, s.id, "بكم ماء الكمأة؟");
    const systems = replySystems();
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]).toContain(BANNED);
    expect(systems[0]).toContain(ALLOWED);
  });
});

/**
 * قرار المالك على main (67093e8): «لا Hermes بأي نص مرئي» — تسميات عامة
 * (الوكيل الذكي …) والقيم الداخلية (`hermes` · `hermes-bridge` · `HERMES_*` ·
 * `hermes-agent`) والتعليقات بتضل. نفس القاعدة على واجهات P12 والتسميات اللي بتعرضها.
 */
describe("P12 × main — ولا اسم Hermes بأي نص مرئي بواجهات P12", () => {
  const P12_UI = [
    "src/app/(dashboard)/settings/agents/page.tsx",
    "src/app/(dashboard)/settings/integrations/page.tsx",
    "src/app/(dashboard)/settings/page.tsx",
    "src/app/(dashboard)/settings/ai/page.tsx",
    "src/components/agents/drafts-queue.tsx",
    "src/components/agents/external-agent-risk.tsx",
    "src/components/integrations/oms-card.tsx",
    "src/components/integrations/system-card.tsx",
    "src/components/integrations/settings-cards.tsx",
    "src/components/integrations/token-manager.tsx",
    "src/components/orders/oms-handoff-card.tsx",
    "src/components/products/compliance-card.tsx",
    "src/components/inbox/marketing-card.tsx",
  ];
  /** النص المرئي تقريبًا = المصدر بلا تعليقات وبلا المعرّفات التقنية المسموحة. */
  const visible = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1")
      .replace(/value="hermes"/g, "")
      .replace(/["'`]hermes(-bridge)?["'`]/g, "")
      .replace(/\bhermes(?=\s*:)/g, "")
      .replace(/HERMES_[A-Z_]+/g, "")
      .replace(/hermes-agent/g, "");

  it.each(P12_UI)("%s: بلا اسم العلامة", (f) => {
    expect(visible(readFileSync(f, "utf8"))).not.toMatch(/hermes/i);
  });

  it("أسماء الأنظمة والتوكنات المعروضة عامة (والمعرّف الداخلي hermes-bridge ثابت)", () => {
    expect(TOKEN_PRESETS["hermes-bridge"].nameAr).not.toMatch(/hermes/i);
    for (const spec of Object.values(SYSTEM_SPECS) as Array<Record<string, unknown>>) {
      for (const [k, v] of Object.entries(spec)) {
        if (typeof v === "string" && /Ar$/.test(k)) expect(v, k).not.toMatch(/hermes/i);
      }
    }
  });
});
