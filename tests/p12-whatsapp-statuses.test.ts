import { describe, expect, it } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import type { Db } from "@/modules/customers/service";
import { applyWhatsAppStatuses, extractWhatsAppStatuses } from "@/modules/channels/whatsapp/statuses";
import { ingestWhatsAppWebhook } from "@/modules/channels/whatsapp/webhook";
import { signPayload, verifyPayload } from "@/core/crypto";

/**
 * P12 — إشارات تسليم واتساب (statuses[]) بتحدّث حالة رسائلنا الصادرة:
 * للأمام بس · «فشل» ما بيغطي على رسالة وصلت · داخل مساحة القناة بس ·
 * إشارة بلا رسالة معروفة بتنتجاهل. (كانت تنرمى ← نتائج الحملات صفر.)
 */

const WS = "ws-wa-1";
type Row = Record<string, any>;
const asDb = (d: ReturnType<typeof createFakeDb>) => d as unknown as Db;

function payload(phoneNumberId: string, statuses: Row[]) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, statuses } }] }],
  };
}

describe("P12 WhatsApp statuses", () => {
  it("استخراج: الحالات المعروفة بس · رقم الرسالة · الوقت · رمز الخطأ للفشل · رقم واتساب الصحيح بس", () => {
    const p = payload("pn-1", [
      { id: "wamid.A", status: "delivered", timestamp: "1760149440", recipient_id: "963936000000" },
      { id: "wamid.B", status: "failed", timestamp: "1760149441", errors: [{ code: 131026, title: "Message undeliverable" }] },
      { id: "wamid.C", status: "deleted" },
      { status: "read" },
    ]);
    const sig = extractWhatsAppStatuses(p, "pn-1");
    expect(sig).toEqual([
      { wamid: "wamid.A", status: "DELIVERED", at: new Date(1760149440 * 1000), errorCode: null },
      { wamid: "wamid.B", status: "FAILED", at: new Date(1760149441 * 1000), errorCode: "131026" },
    ]);
    expect(extractWhatsAppStatuses(p, "pn-other")).toEqual([]);
    expect(JSON.stringify(sig)).not.toContain("963936000000");
  });

  it("تطبيق: للأمام بس (مقروء ما بيرجع واصل) · فشل ما بيغطي على واصل · مساحة تانية ما بتنلمس", async () => {
    const db = createFakeDb();
    const mk = (id: string, ws: string, status: string) =>
      db.message.create({ data: { id, workspaceId: ws, conversationId: "c1", direction: "OUTBOUND", senderType: "HUMAN", externalMessageId: `wamid.${id}`, deliveryStatus: status } } as never);
    await mk("m1", WS, "SENT");
    await mk("m2", WS, "READ");
    await mk("m3", WS, "DELIVERED");
    await mk("m4", WS, "SENT");
    await mk("m5", "ws-other", "SENT");
    const at = new Date();
    const n = await applyWhatsAppStatuses(asDb(db), WS, [
      { wamid: "wamid.m1", status: "DELIVERED", at, errorCode: null },
      { wamid: "wamid.m1", status: "READ", at, errorCode: null },
      { wamid: "wamid.m2", status: "DELIVERED", at, errorCode: null },
      { wamid: "wamid.m3", status: "FAILED", at, errorCode: "131026" },
      { wamid: "wamid.m4", status: "FAILED", at, errorCode: "131049" },
      { wamid: "wamid.m5", status: "READ", at, errorCode: null },
      { wamid: "wamid.unknown", status: "READ", at, errorCode: null },
    ]);
    const st = (id: string) => (db._stores.message as Row[]).find((m) => m.id === id)!;
    expect(n).toBe(3);
    expect(st("m1").deliveryStatus).toBe("READ");
    expect(st("m2").deliveryStatus).toBe("READ");
    expect(st("m3").deliveryStatus).toBe("DELIVERED");
    expect(st("m4")).toMatchObject({ deliveryStatus: "FAILED", deliveryError: "WA_131049" });
    expect(st("m5").deliveryStatus).toBe("SENT");
  });

  it("المسار الحي: webhook حالات بس بيحدّث الرسالة وبيتعلّم معالج بلا مهمة", async () => {
    const db = createFakeDb();
    await db.channel.create({ data: { id: "ch-wa", workspaceId: WS, type: "WHATSAPP", status: "CONNECTED", displayName: "wa", externalId: "pn-9" } } as never);
    await db.channelAccount.create({ data: { channelId: "ch-wa", provider: "WHATSAPP", externalAccountId: "pn-9", encryptedCredentials: "x" } } as never);
    await db.message.create({ data: { id: "mm", workspaceId: WS, conversationId: "c1", direction: "OUTBOUND", senderType: "HUMAN", senderId: "campaign-system", externalMessageId: "wamid.Z", deliveryStatus: "SENT" } } as never);
    const res = await ingestWhatsAppWebhook(asDb(db), payload("pn-9", [{ id: "wamid.Z", status: "read", timestamp: "1760149440" }]));
    expect(res).toMatchObject({ status: "OK", normalizedCount: 0 });
    expect((db._stores.message as Row[])[0].deliveryStatus).toBe("READ");
    expect((db._stores.backgroundJob as Row[]).filter((j) => j.type === "process_channel_inbound")).toHaveLength(0);
  });
});

describe("P12 verifyPayload — ترميز قانوني بس", () => {
  it("توقيع بآخر حرف معدّل (نفس البايتات بفك متسامح) بينرفض", () => {
    const token = signPayload({ m: "x", exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verifyPayload(token)).toMatchObject({ m: "x" });
    const [data, sig] = token.split(".");
    // كل البدائل لآخر حرف بالتوقيع: بس الأصلي مقبول.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const accepted = [...alphabet].filter((ch) => verifyPayload(`${data}.${sig.slice(0, -1)}${ch}`) !== null);
    expect(accepted).toEqual([sig.slice(-1)]);
    expect(verifyPayload(`${data}=.${sig}`)).toBeNull();
  });
});
