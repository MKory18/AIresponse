/**
 * REALTIME — حمولة الأحداث وعزلها.
 *
 * يثبت:
 *  - الحدث معرّفات ونوع فقط: أي نص/بيانات عميل إضافية **بتنحذف** ولا بتنتشر.
 *  - النشر يستعمل قناة واحدة + JSON، وفشل `pg_notify` ما بيكسر العمل.
 *  - العزل بالمساحة صارم.
 */
import { describe, expect, it } from "vitest";
import {
  buildRealtimeEvent,
  isEventForWorkspace,
  publishRealtime,
  REALTIME_CHANNEL,
} from "@/modules/realtime/events";

describe("buildRealtimeEvent", () => {
  it("يبني حدثًا بالمعرّفات فقط ويحذف أي بيانات عميل", () => {
    const e = buildRealtimeEvent({
      workspaceId: "ws-1",
      type: "message.inbound",
      conversationId: "conv-1",
      entityId: "msg-1",
      // حقول دخيلة (نص/هاتف) — لازم تنحذف.
      ...({ text: "رقمي 0791234567", phone: "0791234567" } as object),
    });

    expect(e.v).toBe(1);
    expect(e.workspaceId).toBe("ws-1");
    expect(e.type).toBe("message.inbound");
    expect(e.conversationId).toBe("conv-1");
    expect(e.entityId).toBe("msg-1");
    expect(typeof e.at).toBe("string");
    expect(JSON.stringify(e)).not.toContain("0791234567");
    expect(JSON.stringify(e)).not.toContain("text");
  });
});

describe("publishRealtime", () => {
  it("ينشر على قناة واحدة مع JSON", async () => {
    const calls: unknown[][] = [];
    const db = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push([strings.join("?"), ...values]);
        return 1;
      },
    };

    await publishRealtime(db, {
      workspaceId: "ws-1",
      type: "message.outbound",
      conversationId: "conv-1",
      entityId: "msg-2",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("pg_notify");
    expect(calls[0][1]).toBe(REALTIME_CHANNEL);
    const payload = JSON.parse(String(calls[0][2]));
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.type).toBe("message.outbound");
  });

  it("فشل النشر ما بيرمي (best-effort)", async () => {
    const db = {
      $executeRaw: async () => {
        throw new Error("db down");
      },
    };
    await expect(
      publishRealtime(db, { workspaceId: "ws-1", type: "order.created", entityId: "o-1" })
    ).resolves.toBeUndefined();
  });

  it("db بلا $executeRaw = لا شي (وضع الاختبارات)", async () => {
    await expect(
      publishRealtime({}, { workspaceId: "ws-1", type: "conversation.updated" })
    ).resolves.toBeUndefined();
  });
});

describe("isEventForWorkspace", () => {
  it("يعزل المساحات", () => {
    const e = buildRealtimeEvent({ workspaceId: "ws-1", type: "message.inbound" });
    expect(isEventForWorkspace(e, "ws-1")).toBe(true);
    expect(isEventForWorkspace(e, "ws-2")).toBe(false);
    expect(isEventForWorkspace(e, "")).toBe(false);
  });
});
