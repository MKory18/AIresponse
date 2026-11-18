/**
 * الحزمة 3.1 — شاشة المحادثات الجديدة: منطق صرف (دمج حي · معاملات · رسائل غير مؤكدة) + الخادم (ids · العدد الكلي · يحتاجك)
 * + الفقاعات (الوكيل ≠ الموظف) + مفتاح الواجهة + قيود الكود.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { listConversations } from "@/modules/conversations/service";
import { conversationListQuerySchema } from "@/modules/conversations/schemas";
import { findForbiddenTerms } from "@/lib/glossary";
import type { ConversationListItem, MessageItem } from "@/components/inbox/types";
import {
  NO_FILTERS,
  activeFilterCount,
  appendPage,
  attentionConversationCount,
  idempotencyKey,
  listParams,
  mergeFirstPage,
  mergeMessages,
  whoReplies,
} from "@/app/(dashboard)/conversations/v2/model";
import { Bubble, MESSAGE_KIND } from "@/app/(dashboard)/conversations/v2/bubble";

type Db = Prisma.TransactionClient;
const conv = (id: string): ConversationListItem => ({ id }) as unknown as ConversationListItem;
const msg = (o: Partial<MessageItem>): MessageItem => ({ id: "m", senderType: "CUSTOMER", direction: "INBOUND", type: "TEXT", text: "x", mediaUrl: null, deliveryStatus: "SENT", createdAt: "2026-11-17T10:00:00Z", ...o });

describe("model: دمج القائمة الحي", () => {
  it("التحديث الحي بيقدّم الجديد ويحدّث الموجود وما بيمسح المحمّل", () => {
    const prev = [conv("a"), conv("b"), conv("c"), conv("old1"), conv("old2")];
    const fresh = [conv("n"), conv("a"), conv("b")];
    expect(mergeFirstPage(prev, fresh).map((c) => c.id)).toEqual(["n", "a", "b", "c", "old1", "old2"]);
  });
  it("الإلحاق بلا تكرار", () => {
    expect(appendPage([conv("a"), conv("b")], [conv("b"), conv("c")]).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
  it("رسائل غير مؤكدة محلية بتبقى بعد الاستطلاع، والمؤكدة لا", () => {
    const server = [msg({ id: "s1" })];
    const local = [msg({ id: "optimistic-1", deliveryStatus: "FAILED" }), msg({ id: "optimistic-2", deliveryStatus: "SENT" }), msg({ id: "s1" })];
    expect(mergeMessages(server, local).map((m) => m.id)).toEqual(["s1", "optimistic-1"]);
  });
});

describe("model: معاملات الاستعلام والمفتاح", () => {
  it("كل شي من الخادم: تبويب + بحث + فلاتر + مؤشّر + ids", () => {
    const p = listParams({ view: "attention", q: " أحمد ", filters: { status: "OPEN", channelId: "ch1", assignee: "me" }, cursor: "c9", ids: ["a", "b"] });
    expect(Object.fromEntries(p)).toEqual({ limit: "30", view: "attention", q: "أحمد", status: "OPEN", channelId: "ch1", assignee: "me", cursor: "c9", ids: "a,b" });
    expect(Object.fromEntries(listParams({ view: "all", q: "", filters: NO_FILTERS }))).toEqual({ limit: "30" });
  });
  it("عدّاد الفلاتر ومين بيرد ومفتاح عدم التكرار", () => {
    expect(activeFilterCount({ status: "OPEN", channelId: "", assignee: "me" })).toBe(2);
    expect(whoReplies("HUMAN_ACTIVE")).toBe("human");
    expect(whoReplies("AI_ACTIVE")).toBe("agent");
    expect(whoReplies("AI_PAUSED")).toBe("agent");
    expect(idempotencyKey("c1", 5, 0.123456)).toMatch(/^human-ui:c1:5:/);
    expect(idempotencyKey("c1")).not.toBe(idempotencyKey("c1"));
  });
  it("عدّاد «يحتاجك» = محادثات مميّزة", () => {
    expect(attentionConversationCount([{ href: "/conversations?id=a" }, { href: "/conversations?id=a" }, { href: "/conversations?id=b" }, { href: "/orders?order=o" }])).toBe(2);
  });
});

describe("الخادم: ids · العدد الكلي · يحتاجك", () => {
  const WS = "ws-conv";
  let db: ReturnType<typeof createFakeDb>;
  beforeEach(async () => {
    db = createFakeDb();
    await db.workspace.create({ data: { id: WS, name: "w", slug: "w" } } as never);
    await db.channel.create({ data: { id: "ch", workspaceId: WS, type: "FACEBOOK", displayName: "p" } } as never);
    await db.customer.create({ data: { id: "c1", workspaceId: WS, name: "أحمد" } } as never);
    for (const [id, ws] of [["a", WS], ["b", WS], ["c", WS], ["x", "other"]] as const) {
      await db.conversation.create({ data: { id, workspaceId: ws, customerId: "c1", channelId: "ch", channelConversationId: id, lastCustomerMessageAt: new Date() } } as never);
    }
  });

  it("total كلي (مش حجم الصفحة)، ومعزول بالمساحة", async () => {
    const r = await listConversations(db as unknown as Db, { workspaceId: WS, limit: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).not.toBeNull();
    expect(r.total).toBe(3);
  });

  it("ids: محادثات بعينها بس، ومحادثة مساحة تانية ما بتطلع حتى لو ذكرتها", async () => {
    const r = await listConversations(db as unknown as Db, { workspaceId: WS, ids: ["a", "x"] });
    expect(r.items.map((c) => c.id)).toEqual(["a"]);
    expect(r.total).toBe(1);
  });

  it("المخطط: ids بتتحوّل لمصفوفة (حد 30) و view صارمة", () => {
    const ok = conversationListQuerySchema.parse({ ids: "a, b,,c", view: "attention" });
    expect(ok.ids).toEqual(["a", "b", "c"]);
    expect(conversationListQuerySchema.parse({}).ids).toBeUndefined();
    expect(() => conversationListQuerySchema.parse({ view: "everything" })).toThrow();
    expect(conversationListQuerySchema.parse({ ids: Array.from({ length: 50 }, (_, i) => `i${i}`).join(",").slice(0, 400) }).ids!.length).toBeLessThanOrEqual(30);
  });

  it("المسار: «يحتاجك» من نفس مصدر بنود الانتباه (مفلتر بصلاحيات الطالب) و«جديدة» = غير مقروءة", () => {
    const r = readFileSync("src/app/api/conversations/route.ts", "utf8");
    expect(r).toContain('query.view === "attention"');
    expect(r).toContain("getAttention(prisma, auth!.workspaceId, auth!.can)");
    expect(r).toContain('query.view === "new"');
  });
});

describe("الفقاعات", () => {
  const html = (m: MessageItem) => renderToStaticMarkup(createElement(Bubble, { message: m, onRetry: () => {} }));
  it("تصنيف: عميل · وكيل · موظف · ملاحظة · نظام", () => {
    expect(MESSAGE_KIND({ senderType: "CUSTOMER", direction: "INBOUND" })).toBe("customer");
    expect(MESSAGE_KIND({ senderType: "AI", direction: "OUTBOUND" })).toBe("agent");
    expect(MESSAGE_KIND({ senderType: "HUMAN", direction: "OUTBOUND" })).toBe("staff");
    expect(MESSAGE_KIND({ senderType: "HUMAN", direction: "OUTBOUND", isNote: true })).toBe("note");
    expect(MESSAGE_KIND({ senderType: "SYSTEM", direction: "OUTBOUND" })).toBe("system");
  });
  it("الوكيل ≠ الموظف بلون ووسم (الوكيل primary-soft · الموظف باسمه primary)", () => {
    const agent = html(msg({ id: "1", senderType: "AI", direction: "OUTBOUND" }));
    const staff = html(msg({ id: "2", senderType: "HUMAN", direction: "OUTBOUND", senderName: "سارة" }));
    expect(agent).toContain("bg-primary-soft");
    expect(agent).toContain("الوكيل");
    expect(staff).toContain("bg-primary");
    expect(staff).toContain("سارة");
    expect(staff).not.toContain("bg-primary-soft");
  });
  it("رسالة ما انبعتت = سطر أحمر + «أعد الإرسال»، والعادية لا", () => {
    const failed = html(msg({ id: "3", senderType: "HUMAN", direction: "OUTBOUND", deliveryStatus: "FAILED" }));
    expect(failed).toContain("ما انبعتت الرسالة");
    expect(failed).toContain("أعد الإرسال");
    expect(failed).toContain("text-danger");
    expect(html(msg({ id: "4", senderType: "HUMAN", direction: "OUTBOUND" }))).not.toContain("أعد الإرسال");
  });
  it("الملاحظة الداخلية معلّمة «للفريق فقط» وبلا إعادة إرسال، وكل رسالة بسمة data-message-id", () => {
    const note = html(msg({ id: "5", senderType: "HUMAN", direction: "OUTBOUND", isNote: true, text: "سرّي" }));
    expect(note).toContain("للفريق فقط");
    expect(note).not.toContain("أعد الإرسال");
    expect(note).toContain('data-message-id="5"');
  });
});

describe("الصفحة والقيود", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const DIR = join(process.cwd(), "src", "app", "(dashboard)", "conversations", "v2");
  it("الصفحة بتعرض الشاشة الجديدة بس (الوارد القديم انحذف بـ3.8)", () => {
    const p = read("src/app/(dashboard)/conversations/page.tsx");
    expect(p).toContain("<ConversationsView />");
    expect(p).not.toContain("resolveUiVersion");
    expect(p).not.toContain("<Inbox />");
  });
  it("مفتاح واحد للرد، تأكيد حذف للخطِر، وأزرار الكتابة بالصلاحيات", () => {
    const t = read(join(DIR, "thread-pane.tsx"));
    expect(t).toContain("الوكيل يرد");
    expect(t).toContain("أنا أرد");
    expect(t).toContain('"takeover"');
    expect(t).toContain('"release-ai"');
    expect(t).toContain("<ConfirmDialog");
    expect(t).toMatch(/can\("conversations.delete"\)/);
    expect(t).toContain('<Can permission="conversations.reply">');
    expect(t).toContain('can("conversations.takeover")');
  });
  it("ولا كلمة ممنوعة ولا ملف فوق 300 سطر", () => {
    for (const f of readdirSync(DIR)) {
      const code = read(join(DIR, f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(findForbiddenTerms(code).map((x) => x.word), f).toEqual([]);
      expect(code.split("\n").length, f).toBeLessThanOrEqual(300);
    }
  });
});
