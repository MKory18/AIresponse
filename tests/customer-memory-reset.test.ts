/**
 * Customer memory reset — the AI starts from zero, history/orders/audit stay.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { resetCustomerMemory } from "@/modules/customers/memory";
import { loadMemory } from "@/modules/ai/memory";
import { getOrCreateDraft } from "@/modules/orders/draft-service";
import { hasPermission } from "@/modules/rbac/permissions";
import { runCustomerIntelExtraction } from "@/modules/intelligence/service";
import type { AIProvider } from "@/modules/ai/provider";
import { MockAIProvider, setMockAIProvider } from "@/modules/ai/provider";
import { enqueueJob } from "@/modules/jobs/service";
import { runJobs } from "@/modules/jobs/handlers";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-memory";
const CTX = { userId: "u-manager", workspaceId: WS, role: "MANAGER" } as never;

let db: FakeDb;
let customerId: string;
let conversationId: string;

async function seed() {
  db = createFakeDb() as FakeDb;
  const customer = (await db.customer.create({
    data: {
      workspaceId: WS,
      name: "قديم",
      phone: "0790000000",
      address: "عنوان قديم",
      province: "عمان",
    },
  } as never)) as { id: string };
  customerId = customer.id;
  const channel = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "p-mem", sendMode: "AUTO_REPLY" },
  } as never)) as { id: string };
  const conversation = (await db.conversation.create({
    data: {
      workspaceId: WS,
      customerId,
      channelId: channel.id,
      channelConversationId: "c-mem",
      summary: "ملخص قديم",
    },
  } as never)) as { id: string };
  conversationId = conversation.id;
  await db.customerMemory.create({
    data: { workspaceId: WS, customerId, type: "FACT", key: "old", value: "يحب الشوكولاتة", source: "AI" },
  } as never);
  await db.customerIntel.create({
    data: { workspaceId: WS, conversationId, channelId: channel.id, data: { phone: "0790000000" } },
  } as never);
  await db.order.create({
    data: { workspaceId: WS, customerId, orderNumber: "ORD-OLD", status: "CONFIRMED", total: "10.00", currency: "USD" },
  } as never);
}

beforeEach(seed);

describe("مسح ذاكرة العميل", () => {
  it("يحذف الذاكرة/الاستخراج/الملخص ويترك الطلبات والسجل والهوية", async () => {
    const result = await resetCustomerMemory(db as unknown as Db, CTX, customerId);
    expect(result.memoriesDeleted).toBe(1);
    expect(result.intelDeleted).toBe(1);
    expect(result.summariesCleared).toBe(1);

    expect(await db.customerMemory.findMany({ where: { customerId } })).toHaveLength(0);
    expect(await db.customerIntel.findMany({ where: { conversationId } })).toHaveLength(0);
    const conversation = (await db.conversation.findUnique({ where: { id: conversationId } })) as { summary: string | null };
    expect(conversation.summary).toBeNull();
    // Orders + customer identity remain.
    expect(await db.order.findMany({ where: { customerId } })).toHaveLength(1);
    expect(await db.channelIdentity.findMany({ where: { customerId } })).toHaveLength(0); // never seeded
    const customer = (await db.customer.findUnique({ where: { id: customerId } })) as { memoryResetAt: Date | null };
    expect(customer.memoryResetAt).toBeTruthy();
    const audit = (db._stores.auditLog as any[]).filter((a) => a.action === "customer.memory_reset");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("الشوكولاتة");
  });

  it("بعد المسح: لا ذاكرة قديمة ولا تعبئة بيانات قديمة بالمسودة", async () => {
    const before = await loadMemory(db as unknown as Db, WS, customerId);
    expect(before).toHaveLength(1);
    await resetCustomerMemory(db as unknown as Db, CTX, customerId);
    expect(await loadMemory(db as unknown as Db, WS, customerId)).toHaveLength(0);

    const draft = await getOrCreateDraft(db as unknown as Db, WS, conversationId, customerId);
    expect(draft.phone).toBeNull();
    expect(draft.rawAddress).toBeNull();
    expect(draft.customerName).toBeNull();
  });

  it("الذاكرة الجديدة بعد وقت المسح تُستخدم طبيعيًا", async () => {
    await resetCustomerMemory(db as unknown as Db, CTX, customerId);
    const customer = (await db.customer.findUnique({ where: { id: customerId } })) as { memoryResetAt: Date };
    await new Promise((r) => setTimeout(r, 10));
    await db.customerMemory.create({
      data: {
        workspaceId: WS,
        customerId,
        type: "FACT",
        key: "new",
        value: "يفضّل التوصيل صباحًا",
        source: "AI",
        updatedAt: new Date(new Date(customer.memoryResetAt).getTime() + 1000),
      },
    } as never);
    const rows = await loadMemory(db as unknown as Db, WS, customerId, 10, customer.memoryResetAt);
    expect(rows).toHaveLength(1);
  });

  it("مهمة استخراج بدأت قبل المسح لا تعيد بيانات قديمة", async () => {
    const message = (await db.message.create({
      data: {
        workspaceId: WS,
        conversationId,
        senderType: "CUSTOMER",
        direction: "INBOUND",
        type: "TEXT",
        text: "اسمي أحمد ورقمي 0791234567",
      },
    } as never)) as { id: string };

    const provider: AIProvider = {
      name: "stub",
      delivery: "local",
      generateText: async () => ({ text: "", promptTokens: 0, completionTokens: 0, latencyMs: 0 }),
      generateStructured: async () => {
        // The employee wipes memory WHILE the model is running.
        await resetCustomerMemory(db as unknown as Db, CTX, customerId);
        return {
          text: "{}",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          value: {
            customerName: "أحمد",
            phone: "0791234567",
            city: null,
            address: null,
            products: [],
            quantity: null,
            budget: null,
            purchaseIntent: "high",
            needs: [],
            notes: [],
            confidence: 0.9,
            sourceMessageIds: [message.id],
          },
        };
      },
    };

    const out = await runCustomerIntelExtraction(db as unknown as Db, {
      workspaceId: WS,
      messageId: message.id,
      options: { provider, model: "stub", providerName: "stub" },
    });
    expect(out.status).toBe("STALE_MEMORY");
    expect(await db.customerIntel.findMany({ where: { conversationId } })).toHaveLength(0);
    const customer = (await db.customer.findUnique({ where: { id: customerId } })) as { memoryVersion: number };
    expect(customer.memoryVersion).toBe(1);
  });

  it("مهمة ملخص بدأت قبل المسح لا تكتب ملخصًا قديمًا", async () => {
    const mock = new MockAIProvider();
    let wiped = false;
    mock.generateStructured = async () => {
      if (!wiped) {
        wiped = true;
        await resetCustomerMemory(db as unknown as Db, CTX, customerId);
      }
      return {
        text: "{}",
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 1,
        value: { summary: "ملخص من الذاكرة القديمة" },
      };
    };
    setMockAIProvider(mock);
    try {
      await enqueueJob(db as unknown as Db, {
        workspaceId: WS,
        type: "generate_summary",
        payload: { conversationId },
      });
      await runJobs(db as unknown as Db);
    } finally {
      setMockAIProvider(undefined);
    }
    const conversation = (await db.conversation.findUnique({ where: { id: conversationId } })) as {
      summary: string | null;
    };
    expect(conversation.summary).toBeNull();
  });

  it("الصلاحية: المدير يمسح، البيعي لا", () => {
    expect(hasPermission("MANAGER", [], "customers.memory.reset")).toBe(true);
    expect(hasPermission("SALES_AGENT", [], "customers.memory.reset")).toBe(false);
    expect(hasPermission("VIEWER", [], "customers.memory.reset")).toBe(false);
  });
});
