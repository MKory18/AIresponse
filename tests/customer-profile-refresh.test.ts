/**
 * P21 — اسم/صورة العميل الحقيقيان.
 *
 * يثبت:
 *  - الكاش يرجع الاسم المحفوظ (لا null) حتى تُكمَّل صفوف العميل الناقصة.
 *  - force يتجاوز الكاش السلبي ويجيب الاسم المحدّث فورًا (زر التحديث).
 *  - مهمة resolve_sender_profile تُكمِّل Customer.name من الهوية المحفوظة.
 *
 * ⚠️ قاعدة بالذاكرة وGraph وهمي — سلوك لا اتصال حقيقي.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { resolveSenderName } from "@/modules/channels/facebook/profile";
import { FacebookClient } from "@/modules/channels/facebook/client";
import { runJobs } from "@/modules/jobs/handlers";
import { encryptSecret } from "@/core/crypto";

type Db = Prisma.TransactionClient;
type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;
const WS = "ws-profile-refresh";
const PSID = "psid-profile-1";

function clientReturning(payload: Record<string, unknown>) {
  return new FacebookClient({
    fetchImpl: (async () => Response.json(payload)) as typeof fetch,
  });
}

async function seedIdentity(opts?: { identityName?: string | null; customerName?: string | null }) {
  const db = createFakeDb() as FakeDb;
  const customer = (await db.customer.create({
    data: { workspaceId: WS, name: opts?.customerName ?? null, phone: "0791234567" },
  } as never)) as { id: string };
  await db.channelIdentity.create({
    data: {
      workspaceId: WS,
      customerId: customer.id,
      channelType: "FACEBOOK",
      channelExternalId: PSID,
      displayName: opts?.identityName ?? null,
      avatarUrl: null,
      metadata: {},
    },
  } as never);
  return { db, customer };
}

beforeEach(() => {
  // no factory needed: cached path makes no Graph call
});

describe("P21 — اسم العميل الحقيقي", () => {
  it("نداء أول يجيب الاسم، والنداء التاني (cached) يرجّع المحفوظ لا null", async () => {
    const { db } = await seedIdentity();
    const client = clientReturning({ name: "ليلى", profile_pic: "https://fb.example/l.jpg" });

    const first = await resolveSenderName(db as unknown as Db, { workspaceId: WS, psid: PSID, pageToken: "tok", client });
    expect(first.status).toBe("ok");
    expect(first.name).toBe("ليلى");
    expect(first.avatarUrl).toBe("https://fb.example/l.jpg");

    const second = await resolveSenderName(db as unknown as Db, { workspaceId: WS, psid: PSID, pageToken: "tok", client });
    expect(second.cached).toBe(true);
    expect(second.status).toBe("cached");
    // P21 — القيمة المحفوظة ترجع (كانت null قبل الإصلاح).
    expect(second.name).toBe("ليلى");
    expect(second.avatarUrl).toBe("https://fb.example/l.jpg");
  });

  it("force يتجاوز الكاش ويجيب الاسم الجديد بعد تغييره", async () => {
    const { db } = await seedIdentity();
    await resolveSenderName(db as unknown as Db, {
      workspaceId: WS, psid: PSID, pageToken: "tok",
      client: clientReturning({ name: "ليلى", profile_pic: null }),
    });

    const forced = await resolveSenderName(db as unknown as Db, {
      workspaceId: WS, psid: PSID, pageToken: "tok", force: true,
      client: clientReturning({ name: "سامر", profile_pic: "https://fb.example/s.jpg" }),
    });
    expect(forced.cached).toBe(false);
    expect(forced.status).toBe("ok");
    expect(forced.name).toBe("سامر");
    expect(forced.avatarUrl).toBe("https://fb.example/s.jpg");
  });

  it("force بعد نتيجة فارغة (كاش سلبي) يعيد المحاولة ويجيب الاسم", async () => {
    const { db } = await seedIdentity();
    const empty = await resolveSenderName(db as unknown as Db, {
      workspaceId: WS, psid: PSID, pageToken: "tok",
      client: clientReturning({}),
    });
    expect(empty.status).toBe("empty");
    expect(empty.cached).toBe(false);

    // بلا force: النتيجة السلبية محفوظة.
    const cached = await resolveSenderName(db as unknown as Db, {
      workspaceId: WS, psid: PSID, pageToken: "tok",
      client: clientReturning({ name: "اسم متأخر" }),
    });
    expect(cached.cached).toBe(true);
    expect(cached.status).toBe("cached");

    // force: يتجاوز الكاش ويجيب الاسم.
    const forced = await resolveSenderName(db as unknown as Db, {
      workspaceId: WS, psid: PSID, pageToken: "tok", force: true,
      client: clientReturning({ name: "اسم متأخر" }),
    });
    expect(forced.status).toBe("ok");
    expect(forced.name).toBe("اسم متأخر");
  });

  it("مهمة البروفايل تُكمِّل Customer.name من الهوية المحفوظة (cached) بلا نداء Graph", async () => {
    const { db, customer } = await seedIdentity({ identityName: "ليلى", customerName: null });
    const channel = (await db.channel.create({
      data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "page-p21" },
    } as never)) as { id: string };
    const account = (await db.channelAccount.create({
      data: {
        channelId: channel.id,
        provider: "FACEBOOK",
        externalAccountId: "page-p21",
        pageName: "صفحة",
        encryptedCredentials: encryptSecret("tok-p21"),
      },
    } as never)) as { id: string };
    // الهوية عندها profileCheckedAt حديث: resolveSenderName بترجع المحفوظ.
    const identity = (db._stores.channelIdentity as any[]).find((i) => i.channelExternalId === PSID);
    await db.channelIdentity.update({
      where: { id: identity.id },
      data: { metadata: { profileCheckedAt: new Date().toISOString() } },
    } as never);

    await db.backgroundJob.create({
      data: {
        workspaceId: WS,
        type: "resolve_sender_profile",
        payload: { channelAccountId: account.id, psids: [PSID] },
        runAfter: new Date(0),
      },
    } as never);

    const out = await runJobs(db as never);
    expect(out.failed).toBe(0);
    // مهمة البروفايل منفصلة عن دورة الطابور (P17) — ننتظر أثرها.
    await vi.waitFor(
      () => {
        const refreshed = (db._stores.customer as any[]).find((c) => c.id === customer.id);
        expect(refreshed?.name).toBe("ليلى");
      },
      { timeout: 1500, interval: 20 }
    );
  });
});
