/**
 * ربط عدة صفحات مرة وحدة + حذف الصفحة القديمة حتى لو لسا «مربوطة» عندنا.
 *
 * ⚠️ شاشة الربط كانت تخلّيك تختار صفحة وحدة وترمي الباقي، فكل صفحة إضافية =
 * دورة موافقة جديدة عند فيسبوك. ولو بكل دورة اخترت صفحة وحدة، فيسبوك بيعتبرها
 * كل الصلاحية الجديدة وبيسحب الوصول من القديمة — فتوكنها بيموت وهي لسا
 * `CONNECTED` عندنا، وبتضل بالقائمة بلا ما تستقبل ولا ترد، وما في طريقة تشيلها
 * (الشيل كان للمش-مربوطة بس).
 * 🔧 اختيار كل الصفحات مرة وحدة · تحذير بأسماء المربوطة اللي ما رجعت · وشيل
 * الصفحة المربوطة بتأكيد صريح (بيفصلها أول، وبعدين بينأرشفها — السجل بيضل).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pagesAtRisk, connectSelected, type ChannelRow } from "@/app/(dashboard)/channels/v2/model";
import { disconnectFacebookPage } from "@/modules/channels/facebook/disconnect";
import { archiveFacebookPage } from "@/modules/channels/facebook/archive";
import { decryptSecret, encryptSecret } from "@/core/crypto";
import { AppError, NotFoundError } from "@/core/errors";

const ROOT = process.cwd();
const VIEW = readFileSync(join(ROOT, "src/app/(dashboard)/channels/v2/channels-view.tsx"), "utf8");
const CARD = readFileSync(join(ROOT, "src/app/(dashboard)/channels/v2/channel-card.tsx"), "utf8");
const ROUTE = readFileSync(join(ROOT, "src/app/api/channels/facebook/route.ts"), "utf8");
const DISCONNECT_ROUTE = readFileSync(join(ROOT, "src/app/api/channels/facebook/disconnect/route.ts"), "utf8");

function row(over: Partial<ChannelRow>): ChannelRow {
  return {
    id: "c", type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة", externalId: "p", aiPersonaId: null,
    sendMode: "AUTO_REPLY", market: null, catalog: null, hasAccount: true, tokenStatus: "VALID",
    connectedAt: null, lastWebhookAt: null, lastSendAt: null, ...over,
  };
}

describe("الصفحات المربوطة اللي ما رجعت من فيسبوك", () => {
  const pending = [{ id: "p2", name: "الجديدة" }];

  it("مربوطة وما رجعت بقائمة فيسبوك = بخطر", () => {
    const old = row({ id: "c1", externalId: "p1", displayName: "القديمة" });
    expect(pagesAtRisk(pending, [old]).map((r) => r.displayName)).toEqual(["القديمة"]);
  });

  it("مربوطة ورجعت = آمنة", () => {
    expect(pagesAtRisk(pending, [row({ externalId: "p2" })])).toEqual([]);
  });

  it("الموقوفة والقنوات التانية ما بتنحسب — بس المربوطة الفيسبوكية", () => {
    const rows = [
      row({ id: "a", externalId: "p1", status: "DISCONNECTED" }),
      row({ id: "b", externalId: "p3", status: "ERROR" }),
      row({ id: "c", externalId: "t1", type: "TELEGRAM" }),
    ];
    expect(pagesAtRisk(pending, rows)).toEqual([]);
  });

  it("بلا صفحات مربوطة = ولا تحذير", () => {
    expect(pagesAtRisk(pending, [])).toEqual([]);
  });
});

describe("ربط المحدد دفعة وحدة", () => {
  it("بيربط كل المحدد بالترتيب", async () => {
    const calls: string[] = [];
    const res = await connectSelected(["a", "b", "c"], async (id) => {
      calls.push(id);
    });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(res.linked).toEqual(["a", "b", "c"]);
    expect(res.failed).toEqual([]);
  });

  it("فشل وحدة ما بيوقّف الباقي — وبيتسجّل سببها", async () => {
    // ⚠️ لو وقفنا عند أول فشل، صفحة واحدة بطيئة بتحرم الباقي.
    const res = await connectSelected(["a", "b", "c"], async (id) => {
      if (id === "b") throw new Error("ميتا رفضت");
    });
    expect(res.linked).toEqual(["a", "c"]);
    expect(res.failed).toEqual([{ id: "b", message: "ميتا رفضت" }]);
  });

  it("خطأ مش Error بيصير رسالة عامة مش انهيار", async () => {
    const res = await connectSelected(["a"], async () => {
      throw "boom";
    });
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].message.length).toBeGreaterThan(5);
  });

  it("قائمة فاضية = ولا طلب", async () => {
    let n = 0;
    const res = await connectSelected([], async () => {
      n += 1;
    });
    expect(n).toBe(0);
    expect(res).toEqual({ linked: [], failed: [] });
  });
});

describe("فصل الصفحة قبل شيلها", () => {
  function fakeDb(status = "CONNECTED") {
    const channelUpdates: Array<Record<string, unknown>> = [];
    const accountUpdates: Array<Record<string, unknown>> = [];
    return {
      channelUpdates,
      accountUpdates,
      channel: {
        findFirst: async () => ({
          id: "ch-1",
          status,
          account: { id: "acc-1", encryptedCredentials: encryptSecret("live-page-token") },
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          channelUpdates.push(args.data);
          return {};
        },
      },
      channelAccount: {
        update: async (args: { data: Record<string, unknown> }) => {
          accountUpdates.push(args.data);
          return {};
        },
      },
    };
  }

  it("بيوقّف الاستقبال ويتلف التوكن", async () => {
    const db = fakeDb();
    const unsub: string[] = [];
    await disconnectFacebookPage(db, { unsubscribePageFromApp: async (t, p) => (unsub.push(`${t}|${p}`), { unsubscribed: true }) }, { workspaceId: "ws", pageId: "p1" });
    expect(unsub).toEqual(["live-page-token|p1"]);
    expect(db.channelUpdates[0].status).toBe("DISCONNECTED");
    expect(decryptSecret(String(db.accountUpdates[0].encryptedCredentials))).toBe("revoked");
    expect(db.accountUpdates[0].tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("فشل ميتا ما بيمنع الفصل", async () => {
    // الصفحة القديمة غالبًا ميتا ساحبة وصولها — إلغاء الاشتراك أكيد بيفشل عليها.
    const db = fakeDb();
    await disconnectFacebookPage(db, { unsubscribePageFromApp: async () => { throw new Error("(#190) token invalid"); } }, { workspaceId: "ws", pageId: "p1" });
    expect(db.channelUpdates[0].status).toBe("DISCONNECTED");
  });

  it("صفحة مش موجودة = ما لقيناها", async () => {
    const db = { ...fakeDb(), channel: { findFirst: async () => null, update: async () => ({}) } };
    await expect(disconnectFacebookPage(db, { unsubscribePageFromApp: async () => ({ unsubscribed: true }) }, { workspaceId: "ws", pageId: "p" })).rejects.toThrow(NotFoundError);
  });

  it("مسار الفصل القديم بيستعمل نفس الدالة — ولا نسختين", () => {
    expect(DISCONNECT_ROUTE).toMatch(/disconnectFacebookPage/);
  });
});

describe("حذف الصفحة المربوطة بتأكيد", () => {
  it("بلا تأكيد المربوطة لسا بترفض (الحماية الأصلية)", async () => {
    const db = {
      channel: { findFirst: async () => ({ id: "c", status: "CONNECTED", archivedAt: null }), update: async () => ({}) },
    };
    await expect(archiveFacebookPage(db, { workspaceId: "ws", pageId: "p" })).rejects.toThrow(AppError);
  });

  it("المسار بيفصل قبل الأرشفة بس لما المالك يأكّد", () => {
    expect(ROUTE).toMatch(/disconnect:\s*z\.boolean\(\)\.optional\(\)/);
    const stop = ROUTE.indexOf("disconnectFacebookPage(");
    const archive = ROUTE.indexOf("archiveFacebookPage(prisma");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(archive);
    expect(ROUTE).toMatch(/body\.disconnect/);
  });

  it("الخيار بيظهر لكل صفحة فيسبوك — مش للموقوفة بس", () => {
    // ⚠️ كان بيختفي للـCONNECTED، والصفحة القديمة اللي ميتا سحبت وصولها
    // بتضل CONNECTED عندنا — فما في طريقة تشيلها.
    expect(CARD).toMatch(/row\.type === "FACEBOOK"/);
    expect(CARD).not.toMatch(/row\.type === "FACEBOOK" && row\.status !== "CONNECTED"/);
  });

  it("الواجهة بتبعت التأكيد للمربوطة بس وبتحذّر قبله", () => {
    expect(VIEW).toMatch(/disconnect:\s*row\.status === "CONNECTED"/);
    expect(VIEW).toMatch(/archiveConnectedBody/);
  });
});

describe("شاشة اختيار الصفحات", () => {
  it("اختيار متعدد مش صفحة وحدة", () => {
    expect(VIEW).toMatch(/type="checkbox"/);
    expect(VIEW).toMatch(/connectSelected/);
  });

  it("كل الصفحات معلّمة من البداية", () => {
    expect(VIEW).toMatch(/new Set\(pages\.map/);
  });

  it("بتحذّر بأسماء المربوطة اللي ما رجعت", () => {
    expect(VIEW).toMatch(/pagesAtRisk/);
  });
});
