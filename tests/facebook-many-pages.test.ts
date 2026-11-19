/**
 * عدة صفحات فيسبوك بنفس مساحة العمل بنفس الوقت — كل وحدة بتستقبل لحالها.
 *
 * السؤال: لما المالك يربط صفحة تانية، هل الأولى بتوقف؟ هالاختبار بيثبت إنه
 * البرنامج (القاعدة + مسار الاستقبال) ما بيربط صفحة بصفحة: كل صفحة = قناة +
 * حساب + توكن إلها، والرسالة بتنوجّه بمعرّف الصفحة اللي جاية منها.
 * فلو صفحة وقفت تستقبل بعد ربط تانية، السبب مش هون — بيكون عند ميتا
 * (الصلاحية انسحبت من الصفحة القديمة، أو الاشتراك بالـwebhook ناقص).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;

const WS = "ws-many";
const PAGES = ["page-111", "page-222", "page-333"];

let db: ReturnType<typeof createFakeDb>;

function payload(pageId: string, mid: string) {
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          { sender: { id: `psid-${mid}` }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text: "مرحبا" } },
        ],
      },
    ],
  };
}

async function connect(pageId: string, status: "CONNECTED" | "DISCONNECTED" = "CONNECTED") {
  const ch = await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status, displayName: pageId, externalId: pageId },
  } as never);
  await db.channelAccount.create({
    data: {
      channelId: (ch as { id: string }).id,
      provider: "FACEBOOK",
      externalAccountId: pageId,
      pageName: pageId,
      encryptedCredentials: encryptSecret(`token-of-${pageId}`),
    },
  } as never);
  return ch as { id: string };
}

beforeEach(() => {
  db = createFakeDb();
});

describe("عدة صفحات بنفس المساحة", () => {
  it("كل صفحة مربوطة بتستقبل رسايلها", async () => {
    for (const id of PAGES) await connect(id);
    for (const id of PAGES) {
      const res = await ingestMetaWebhook(db as Db, payload(id, `mid-${id}`));
      expect(res.status).toBe("OK");
    }
  });

  it("ربط صفحة جديدة ما بيغيّر حالة اللي قبلها", async () => {
    const first = await connect(PAGES[0]);
    await connect(PAGES[1]);
    await connect(PAGES[2]);
    const rows = (await db.channel.findMany({ where: { workspaceId: WS } } as never)) as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "CONNECTED")).toBe(true);
    expect(rows.find((r) => r.id === first.id)?.status).toBe("CONNECTED");
  });

  it("كل صفحة بتحتفظ بتوكنها هي", async () => {
    for (const id of PAGES) await connect(id);
    const accounts = (await db.channelAccount.findMany({} as never)) as Array<{ externalAccountId: string; encryptedCredentials: string }>;
    expect(new Set(accounts.map((a) => a.encryptedCredentials)).size).toBe(PAGES.length);
  });

  it("رسالة بتنوجّه للصفحة اللي جاية منها — حتى بدفعة وحدة مختلطة", async () => {
    for (const id of PAGES) await connect(id);
    const mixed = {
      object: "page",
      entry: PAGES.map((id) => payload(id, `mixed-${id}`).entry[0]),
    };
    const res = await ingestMetaWebhook(db as Db, mixed);
    expect(res.status).toBe("OK");
    expect(res.normalizedCount).toBe(PAGES.length);
  });

  it("صفحة موقوفة بتنرمى بصوت عالي وما بتأثر على الباقي", async () => {
    await connect(PAGES[0], "DISCONNECTED");
    await connect(PAGES[1]);
    expect((await ingestMetaWebhook(db as Db, payload(PAGES[0], "m-a"))).status).toBe("UNKNOWN_PAGE");
    expect((await ingestMetaWebhook(db as Db, payload(PAGES[1], "m-b"))).status).toBe("OK");
  });
});
