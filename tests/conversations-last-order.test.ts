/**
 * 3.1ب — شارة حالة آخر طلب بقائمة المحادثات: الخادم بيرجّع `lastOrder` (الأحدث لكل محادثة، استعلام واحد)،
 * والصف بيرسمها بالواجهة الجديدة بس (`showOrder`) — القديمة ما بتتغيّر.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { listConversations } from "@/modules/conversations/service";
import { ConversationItem } from "@/components/inbox/conversation-item";
import type { ConversationListItem } from "@/components/inbox/types";

type Db = Prisma.TransactionClient;
type Row = Record<string, any>;
const WS = "ws-last-order";
const WS_B = "ws-last-order-b";
let db: ReturnType<typeof createFakeDb>;
const stores = () => db._stores as Record<string, Row[]>;

async function conversation(ws: string, tag: string) {
  const ch = (await db.channel.create({ data: { workspaceId: ws, type: "FACEBOOK", status: "CONNECTED", externalId: `pg-${tag}` } } as never)) as Row;
  const cu = (await db.customer.create({ data: { workspaceId: ws, name: `عميل ${tag}` } } as never)) as Row;
  return (await db.conversation.create({
    data: { workspaceId: ws, customerId: cu.id, channelId: ch.id, channelConversationId: `cc-${tag}`, status: "OPEN", lastCustomerMessageAt: new Date() },
  } as never)) as Row;
}
const order = (ws: string, conversationId: string, over: Row) =>
  stores().order.push({ id: `o${stores().order.length + 1}`, workspaceId: ws, orderNumber: `N${stores().order.length + 1}`, customerId: "c", conversationId, status: "NEW", sealedAt: null, heldBy: null, omsStatus: null, omsShippingStatus: null, createdAt: new Date(), ...over });

beforeEach(() => {
  db = createFakeDb();
});

describe("الخادم: lastOrder", () => {
  it("الأحدث لكل محادثة، null لمن ما إلها طلب، وطلب مساحة ثانية ما بيدخل", async () => {
    const a = await conversation(WS, "a");
    const b = await conversation(WS, "b");
    const c = await conversation(WS, "c");
    order(WS, a.id, { status: "CANCELLED", createdAt: new Date("2026-11-01T10:00:00Z") });
    order(WS, a.id, { status: "CONFIRMED", sealedAt: new Date("2026-11-02T10:00:00Z"), createdAt: new Date("2026-11-02T10:00:00Z") });
    order(WS, b.id, { status: "CONFIRMATION_PENDING", createdAt: new Date("2026-11-03T10:00:00Z") });
    order(WS_B, c.id, { status: "DELIVERED", createdAt: new Date("2026-11-04T10:00:00Z") });
    const r = await listConversations(db as unknown as Db, { workspaceId: WS, limit: 30 });
    const by = new Map(r.items.map((i) => [i.id, i.lastOrder]));
    expect(by.get(a.id)).toMatchObject({ status: "CONFIRMED" });
    expect(by.get(a.id)!.sealedAt).toMatch(/^2026-11-02/);
    expect(by.get(b.id)).toMatchObject({ status: "CONFIRMATION_PENDING" });
    expect(by.get(c.id)).toBeNull();
  });
});

describe("الصف", () => {
  const item = (lastOrder: ConversationListItem["lastOrder"]): ConversationListItem =>
    ({
      id: "x", status: "OPEN", aiState: "AI_ACTIVE", priority: "NORMAL", tags: [], unreadCount: 0, summary: null,
      lastCustomerMessageAt: null, lastAgentMessageAt: null, assignedAgentId: null,
      customer: { id: "c", name: "سامر", phone: null, status: "NEW_LEAD" }, channel: { type: "FACEBOOK" }, assignedAgent: null, lastOrder,
    }) as ConversationListItem;
  const html = (c: ConversationListItem, showOrder?: boolean) =>
    renderToStaticMarkup(createElement(ConversationItem, { conversation: c, selected: false, onSelect: () => {}, showOrder }));

  it("بالجديدة: الشارة بنص حالة الطلب (مثبّت · تحتاج مراجعة)", () => {
    expect(html(item({ status: "CONFIRMED", sealedAt: "2026-11-02T10:00:00Z", heldBy: null, omsStatus: null, omsShippingStatus: null }), true)).toContain("مثبّت");
    expect(html(item({ status: "CONFIRMATION_PENDING", sealedAt: null, heldBy: null, omsStatus: null, omsShippingStatus: null }), true)).toContain("تحتاج مراجعة");
  });
  it("بلا showOrder (القديمة) أو بلا طلب: ولا شارة", () => {
    const o = { status: "CONFIRMED", sealedAt: "2026-11-02T10:00:00Z", heldBy: null, omsStatus: null, omsShippingStatus: null };
    expect(html(item(o))).not.toContain("مثبّت");
    expect(html(item(null), true)).not.toContain("مثبّت");
  });
});
