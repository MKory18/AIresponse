/**
 * ختم الرسالة داخل النظام: مين كتبها؟
 *
 * يثبت:
 *  - رسالة الذكاء = «الذكاء الاصطناعي».
 *  - رسالة الموظف = اسمه من جدول المستخدمين (بلا تخمين).
 *  - رسالة العميل = بلا ختم.
 *  - النص لا يتغيّر، والختم للعرض الداخلي فقط.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { listMessages } from "@/modules/conversations/threads";

const WS = "ws-stamps";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
});

async function seed() {
  await db.workspace.create({ data: { id: WS, name: "مساحة" } } as never);
  const customer = (await db.customer.create({ data: { workspaceId: WS, name: "زبون" } } as never)) as { id: string };
  const channel = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة" },
  } as never)) as { id: string };
  const conversation = (await db.conversation.create({
    data: { workspaceId: WS, customerId: customer.id, channelId: channel.id, channelConversationId: "c1" },
  } as never)) as { id: string };
  const agent = (await db.user.create({
    data: { workspaceId: WS, email: "sara@x.test", name: "سارة", passwordHash: "h" },
  } as never)) as { id: string };

  await db.message.create({
    data: { workspaceId: WS, conversationId: conversation.id, direction: "INBOUND", senderType: "CUSTOMER", type: "TEXT", text: "مرحبا" },
  } as never);
  await db.message.create({
    data: { workspaceId: WS, conversationId: conversation.id, direction: "OUTBOUND", senderType: "AI", senderId: "ai-agent", type: "TEXT", text: "أهلاً", deliveryStatus: "SENT" },
  } as never);
  await db.message.create({
    data: { workspaceId: WS, conversationId: conversation.id, direction: "OUTBOUND", senderType: "HUMAN", senderId: agent.id, type: "TEXT", text: "كيف بقدر ساعدك؟", deliveryStatus: "SENT" },
  } as never);

  return { conversationId: conversation.id, agentId: agent.id };
}

describe("ختم المرسل", () => {
  it("AI = الذكاء الاصطناعي · HUMAN = اسم الموظف · CUSTOMER = بلا ختم", async () => {
    const { conversationId, agentId } = await seed();
    const { items } = await listMessages(db as Db, { userId: "u1", workspaceId: WS }, conversationId, {});

    const byText = new Map(items.map((m) => [(m as { text: string }).text, m as unknown as { senderName: string | null; senderId?: string | null; senderType: string; text?: string }]));
    expect(byText.get("أهلاً")?.senderName).toBe("الذكاء الاصطناعي");
    expect(byText.get("كيف بقدر ساعدك؟")?.senderName).toBe("سارة");
    expect(byText.get("كيف بقدر ساعدك؟")?.senderId).toBe(agentId);
    expect(byText.get("مرحبا")?.senderName).toBeNull();
    // النص نفسه ما انلمس
    expect(byText.get("أهلاً")?.text).toBe("أهلاً");
  });
});
