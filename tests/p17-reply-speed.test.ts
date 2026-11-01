/**
 * P17 — سرعة أول رد: اسم/صورة المرسل من Graph ما بيعطّلوا حفظ الرسالة ولا الرد.
 *
 * قبل الإصلاح كان الويب هوك يستنى نداء Graph (حتى 4 ثوانٍ) لكل زبون جديد قبل
 * حفظ الرسالة، فما بتنصفّ مهمة الرد إلا بعد النداء. الاختبار الأول بيفشل قبل
 * الإصلاح (ما في رد لحد ما يفتح البوابة) وبينجح بعده.
 *
 * ⚠️ كل هذا على قاعدة بالذاكرة ومزوّد/فيسبوك وهميين — سلوك لا زمن إنتاج.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { runWorkerTick } from "@/modules/jobs/handlers";
import { setMockAIProvider, MockAIProvider } from "@/modules/ai/provider";
import { FacebookClient, setFacebookClientFactory } from "@/modules/channels/facebook/client";
import { encryptSecret } from "@/core/crypto";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-p17";

function mockReply() {
  const mock = new MockAIProvider();
  mock.intentHandler = () => ({
    intent: "PRODUCT_QUESTION",
    confidence: 0.9,
    entities: {},
    missingFields: [],
    memories: [],
    requestedAction: "ANSWER",
  });
  mock.responseHandler = () => "أهلاً فيك 🌹";
  setMockAIProvider(mock);
}

/** فيسبوك وهمي: إرسال ناجح دائمًا، وجلب البروفايل بينتظر بوابة الاختبار. */
function fbWithGatedProfile(profileGate: Promise<void>, seen: string[] = []) {
  setFacebookClientFactory(
    () =>
      new FacebookClient({
        fetchImpl: (async (url: string) => {
          const u = new URL(url);
          if (u.pathname.includes("/messages")) {
            return Response.json({ recipient_id: "psid", message_id: `mid-${Date.now()}` });
          }
          seen.push("profile_started");
          await profileGate;
          seen.push("profile_done");
          return Response.json({ id: "psid-p17", name: "سامر", profile_pic: "https://fb.example/s.jpg" });
        }) as typeof fetch,
      })
  );
}

async function seedPage(db: FakeDb) {
  const ch = (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "p17-page", externalId: "p17-page" },
  } as never)) as any;
  const account = (await db.channelAccount.create({
    data: {
      channelId: ch.id,
      provider: "FACEBOOK",
      externalAccountId: "p17-page",
      pageName: "p17-page",
      encryptedCredentials: encryptSecret("tok-p17"),
    },
  } as never)) as any;
  return { ch, account };
}

function webhookJob(accountId: string, psid: string, mid: string) {
  return {
    workspaceId: WS,
    type: "process_webhook_event",
    payload: {
      workspaceId: WS,
      webhookEventId: `wh-p17-${mid}`,
      channelAccountId: accountId,
      messages: [
        {
          externalCustomerId: psid,
          externalConversationId: psid,
          externalMessageId: mid,
          externalEventId: `evt-${mid}`,
          text: "شو مواصفات المنتج؟",
        },
      ],
    },
    runAfter: new Date(0),
  };
}

function outboundRows(db: FakeDb) {
  return (db._stores.message as any[]).filter((m) => m.direction === "OUTBOUND");
}

function profileJob(db: FakeDb) {
  return (db._stores.backgroundJob as any[]).find((j) => j.type === "resolve_sender_profile");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  setMockAIProvider(undefined);
  setFacebookClientFactory(undefined as never);
});

describe("P17 — أول رسالة من زبون جديد ما بتستنى Graph", () => {
  it("الرد بيوصل والبروفايل لسا معلّق، والاسم بينحدّث بعدها بلا إرسال إضافي", async () => {
    const db = createFakeDb() as FakeDb;
    mockReply();
    let releaseProfile!: () => void;
    const profileGate = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    const seen: string[] = [];
    fbWithGatedProfile(profileGate, seen);
    const { account } = await seedPage(db);

    await db.backgroundJob.create({ data: webhookJob(account.id, "psid-p17", "mid-p17") } as never);

    const tick = runWorkerTick(db as never);

    // الرد لازم يطلع والبروفايل لسا معلّق (قبل الإصلاح: ما في رد أبدًا هنا).
    await vi.waitFor(() => expect(outboundRows(db)).toHaveLength(1), { timeout: 1500, interval: 20 });
    expect(outboundRows(db)[0].senderType).toBe("AI");
    expect(seen).not.toContain("profile_done"); // البروفايل لسا ما خلص
    await tick;

    // الاسم بيوصل بمهمة مستقلة، والعميل بينحدّث بلا أي رسالة تانية.
    releaseProfile();
    await vi.waitFor(
      () => {
        expect(profileJob(db)?.status).toBe("DONE");
        expect((db._stores.customer as any[])[0]?.name).toBe("سامر");
      },
      { timeout: 1500, interval: 20 }
    );

    // ولا إرسال مكرر بعد دورة تانية.
    await runWorkerTick(db as never);
    expect(outboundRows(db)).toHaveLength(1);
    expect(seen).toContain("profile_done");
    // ولا توكن بالحمولة المخزّنة.
    expect(JSON.stringify(profileJob(db)?.payload ?? {})).not.toContain("tok-p17");
  });
});
