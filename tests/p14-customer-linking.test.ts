/**
 * P14 — جودة الربط بين العميل ومحادثاته.
 *
 * يثبت على خدمة الربط الفعلية (`resolveCustomerByChannelIdentity` + `processIncomingMessage`):
 *  - عدة رسائل لنفس المعرّف الخارجي → عميل واحد (بلا تكرار).
 *  - محادثات متعددة للعميل نفسه (نفس الهوية، قنوات/خيوط مختلفة) → عميل واحد.
 *  - أسماء متشابهة لعملاء مختلفين **لا تُدمج** (الربط بالهوية، لا بالاسم).
 *  - رقم هاتف مكرر/متغيّر لا يُدمج عميلين.
 *  - مساحتان مختلفتان: لا خلط بيانات إطلاقًا.
 *
 * ملاحظة: تعارض المدينة/العنوان مُغطّى في `customer-intel-sync` و`collection-intel-lab`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { resolveCustomerByChannelIdentity, getCustomerDetail, updateCustomer } from "@/modules/customers/service";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

function seedChannel(db: FakeDb, id: string, workspaceId = "ws1") {
  db._stores.channel.push({ id, workspaceId, type: "FACEBOOK", status: "CONNECTED", displayName: id, externalId: id });
}

function inbound(db: FakeDb, over: Record<string, unknown> = {}) {
  return processIncomingMessage(db as never, {
    workspaceId: "ws1",
    channelType: "FACEBOOK",
    channelId: "ch1",
    externalUserId: "psid-A",
    externalConversationId: "psid-A",
    externalMessageId: "mid-1",
    externalEventId: "evt-1",
    provider: "facebook",
    type: "TEXT",
    text: "مرحبا",
    ...over,
  });
}

let db: FakeDb;
beforeEach(() => {
  db = createFakeDb() as FakeDb;
});
afterEach(() => {
  // لا مزوّد ولا شبكة هنا.
});

describe("الربط بالهوية الخارجية", () => {
  it("عدة رسائل لنفس المعرّف الخارجي → عميل واحد", async () => {
    const a = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-A", displayName: "أحمد" } as never);
    const b = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-A", displayName: "أحمد" } as never);
    const c = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-A" } as never);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(c.created).toBe(false);
    expect(b.customerId).toBe(a.customerId);
    expect(c.customerId).toBe(a.customerId);
    expect(db._stores.customer as any[]).toHaveLength(1);
  });

  it("محادثات متعددة للعميل نفسه (نفس الهوية، خيوط مختلفة) → عميل واحد ومحادثتان", async () => {
    seedChannel(db, "ch1");
    seedChannel(db, "ch2");
    const m1 = await inbound(db, { channelId: "ch1", externalConversationId: "thread-1", externalMessageId: "m1", externalEventId: "e1" });
    const m2 = await inbound(db, { channelId: "ch2", externalConversationId: "thread-2", externalMessageId: "m2", externalEventId: "e2" });
    // نفس المعرّف الخارجي (العميل) لكن خيط محادثة مختلف.
    expect(m1.conversationId).not.toBe(m2.conversationId);
    expect((db._stores.customer as any[])).toHaveLength(1);
    const convs = db._stores.conversation as any[];
    expect(convs).toHaveLength(2);
    expect(new Set(convs.map((c) => c.customerId)).size).toBe(1);
  });

  it("أسماء متشابهة لعملاء مختلفين لا تُدمج (لا دمج بالاسم)", async () => {
    const a = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-A", displayName: "أحمد" } as never);
    const b = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-B", displayName: "أحمد" } as never);
    expect(a.customerId).not.toBe(b.customerId);
    expect(db._stores.customer as any[]).toHaveLength(2);
  });

  it("رقم هاتف مكرر لا يُدمج عميلين، ويُرفض الإسناد المكرر داخل المساحة", async () => {
    const a = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-A", displayName: "أحمد" } as never);
    const b = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-B", displayName: "سامر" } as never);
    await updateCustomer(db as never, { userId: "u1", workspaceId: "ws1" }, a.customerId, { phone: "0612345678" } as never);

    // نفس الرقم لعميل آخر → مرفوض (لا دمج ولا تكرار رقم).
    await expect(
      updateCustomer(db as never, { userId: "u1", workspaceId: "ws1" }, b.customerId, { phone: "0612345678" } as never)
    ).rejects.toThrow();

    // العميلان باقيان منفصلين، والرقم على الأول فقط.
    const detailA = await getCustomerDetail(db as never, { userId: "u1", workspaceId: "ws1" }, a.customerId);
    const detailB = await getCustomerDetail(db as never, { userId: "u1", workspaceId: "ws1" }, b.customerId);
    expect(detailA.id).not.toBe(detailB.id);
    expect(detailA.phone).toBe("0612345678");
    expect(detailB.phone ?? null).toBeNull();
    expect(db._stores.customer as any[]).toHaveLength(2);
  });
});

describe("العزل بين المساحات في الربط", () => {
  it("عميلان بمساحتين: لا خلط بيانات، ولا قراءة عبر المساحة", async () => {
    const a = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-A", displayName: "أحمد" } as never);
    const b = await resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws-B", channelType: "FACEBOOK", externalUserId: "psid-B", displayName: "سامر" } as never);
    await updateCustomer(db as never, { userId: "u1", workspaceId: "ws1" }, a.customerId, { city: "عمان" } as never);
    await updateCustomer(db as never, { userId: "u2", workspaceId: "ws-B" }, b.customerId, { city: "إربد" } as never);

    const detailA = await getCustomerDetail(db as never, { userId: "u1", workspaceId: "ws1" }, a.customerId);
    expect(detailA.city).toBe("عمان");

    // مساحة ws1 لا تقرأ عميل ws-B.
    await expect(getCustomerDetail(db as never, { userId: "u1", workspaceId: "ws1" }, b.customerId)).rejects.toThrow();
    // وهوية تنتمي لمساحة أخرى = رفض صريح (لا تسريب وجود).
    db._stores.channelIdentity.push({ id: "ci-x", workspaceId: "ws-B", customerId: b.customerId, channelType: "FACEBOOK", channelExternalId: "psid-C" });
    await expect(
      resolveCustomerByChannelIdentity(db as never, { workspaceId: "ws1", channelType: "FACEBOOK", externalUserId: "psid-C" } as never)
    ).rejects.toThrow();
  });
});
