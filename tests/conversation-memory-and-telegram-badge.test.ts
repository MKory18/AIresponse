/**
 * حذف ذاكرة المحادثة + شعار «تم ترحيله للتلجرام» للطلبات الجاهزة.
 *
 * يثبت:
 *  - الحذف يمسّ فقط الذاكرة اللي مصدرها رسائل هالمحادثة (مش ذاكرة العميل كلها).
 *  - ملخّص المحادثة ينمسح، والرسائل والطلبات بتضل.
 *  - محادثة مساحة تانية = «غير موجود» (عزل).
 *  - الشعار يتبع سجل الإرسال الفعلي: اللي انبعت فقط، وبعزل المساحة.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { resetConversationMemory } from "@/modules/customers/memory";
import { telegramNotifiedDraftIds } from "@/modules/orders/ready-drafts";

const WS = "ws-memory";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
});

async function seedConversation(opts?: { workspaceId?: string; id?: string; customerId?: string }) {
  const workspaceId = opts?.workspaceId ?? WS;
  const customerId = opts?.customerId ?? "cust-1";
  const conversationId = opts?.id ?? "conv-1";
  await db.conversation.create({
    data: { id: conversationId, workspaceId, customerId, summary: "ملخص قديم" },
  } as never);
  await db.message.create({ data: { id: "msg-1", conversationId, workspaceId, direction: "INBOUND" } } as never);
  await db.message.create({ data: { id: "msg-2", conversationId, workspaceId, direction: "OUTBOUND" } } as never);
  return { conversationId, customerId, workspaceId };
}

describe("resetConversationMemory", () => {
  it("يحذف ذاكرة هذه المحادثة فقط + الملخّص، ويترك الباقي", async () => {
    const { conversationId } = await seedConversation();
    // ذاكرة مصدرها رسائل هالمحادثة
    await db.customerMemory.create({
      data: { workspaceId: WS, customerId: "cust-1", type: "FACT", key: "k1", value: "يحب الشاي", source: "ai_extraction:msg-1" },
    } as never);
    await db.customerMemory.create({
      data: { workspaceId: WS, customerId: "cust-1", type: "PREFERENCE", key: "k2", value: "يفضل المساء", source: "ai_extraction:msg-2" },
    } as never);
    // ذاكرة محادثة تانية لنفس العميل — لازم تبقى
    await db.customerMemory.create({
      data: { workspaceId: WS, customerId: "cust-1", type: "FACT", key: "k3", value: "يسكن عمّان", source: "ai_extraction:msg-old" },
    } as never);

    const result = await resetConversationMemory(db as Db, { workspaceId: WS, userId: "owner-1" }, conversationId);

    expect(result.deleted).toBe(2);
    const rows = db._stores.customerMemory as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("يسكن عمّان");
    // الملخص انمسح · الرسائل بتضل
    const conv = (db._stores.conversation as any[]).find((c) => c.id === conversationId);
    expect(conv.summary).toBeNull();
    expect((db._stores.message as any[]).filter((m) => m.conversationId === conversationId)).toHaveLength(2);
    // سجل التدقيق موجود بلا نص ذاكرة
    const audit = (db._stores.auditLog as any[]).find((a) => a.action === "conversation.memory_reset");
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain("الشاي");
  });

  it("محادثة مساحة أخرى = غير موجودة", async () => {
    const { conversationId } = await seedConversation({ workspaceId: "ws-other" });
    await expect(
      resetConversationMemory(db as Db, { workspaceId: WS, userId: "owner-1" }, conversationId)
    ).rejects.toThrow();
  });
});

describe("telegramNotifiedDraftIds", () => {
  it("يرجّع فقط المسودات اللي إلها سجل إرسال ناجح", async () => {
    (db._stores.auditLog as any[]).push(
      { id: "a1", workspaceId: WS, action: "order.ready_notified_telegram", entityType: "OrderDraft", entityId: "d1", metadata: {} },
      { id: "a2", workspaceId: "ws-other", action: "order.ready_notified_telegram", entityType: "OrderDraft", entityId: "d2", metadata: {} },
      { id: "a3", workspaceId: WS, action: "order.created", entityType: "Order", entityId: "d3", metadata: {} }
    );

    const ids = await telegramNotifiedDraftIds(db as Db, WS, ["d1", "d2", "d3"]);
    expect([...ids]).toEqual(["d1"]);
  });

  it("بلا مسودات = مجموعة فاضية بلا استعلام", async () => {
    const ids = await telegramNotifiedDraftIds(db as Db, WS, []);
    expect(ids.size).toBe(0);
  });
});
