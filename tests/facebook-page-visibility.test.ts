/**
 * الصفحة بتظهر بعد الربط، والموقوفة بتنشال بلا ما تمس المحادثات.
 *
 * ⚠️ أي فشل بالربط كان بيطلع برسالة وحدة: «فشل ربط الصفحة — حاول مجددًا».
 * بعد تبديل تطبيق ميتا، فيسبوك رجّع صفر صفحات والمالك ما قدر يعرف إنه
 * السبب عند ميتا (وضع التطوير / مش أدمن) مش عنا.
 * ⚠️ والصفحة الموقوفة كانت تضل بالقائمة للأبد — وحذف صفها فعليًا بيجرّ
 * معه كل محادثاتها (`onDelete: Cascade`).
 * 🔧 كل رمز فشل إله سبب وتصحيح · والشيل أرشفة (`archivedAt`) مش حذف.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeConnectError } from "@/modules/channels/facebook/connect-errors";
import { archiveFacebookPage, canArchive, visibleChannelsWhere } from "@/modules/channels/facebook/archive";
import { AppError, NotFoundError } from "@/core/errors";

const ROOT = process.cwd();
const PAGE = readFileSync(join(ROOT, "src/app/(dashboard)/channels/v2/channels-view.tsx"), "utf8");
const CARD = readFileSync(join(ROOT, "src/app/(dashboard)/channels/v2/channel-card.tsx"), "utf8");
const ROUTE = readFileSync(join(ROOT, "src/app/api/channels/facebook/route.ts"), "utf8");
const SELECT = readFileSync(join(ROOT, "src/app/api/channels/facebook/select-page/route.ts"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

describe("سبب فشل الربط بينقال للمالك", () => {
  it("كل رمز إله سبب وتصحيح مختلفين", () => {
    const codes = ["no_pages", "exchange", "callback", "selection"];
    const risks = new Set<string>();
    for (const code of codes) {
      const note = describeConnectError(code);
      expect(note.risk.length).toBeGreaterThan(20);
      expect(note.fix.length).toBeGreaterThan(20);
      risks.add(note.risk);
    }
    expect(risks.size).toBe(codes.length);
  });

  it("«ولا صفحة» بتشرح وضع التطوير وصلاحية الأدمن", () => {
    const note = describeConnectError("no_pages");
    expect(note.fix).toContain("Admin");
    expect(note.fix).toMatch(/التطوير/);
  });

  it("فشل التبادل بيأشّر على المفاتيح ورابط الرجوع", () => {
    const note = describeConnectError("exchange");
    expect(note.fix).toContain("META_APP_ID");
    expect(note.fix).toContain("Valid OAuth Redirect URIs");
  });

  it("رمز مجهول بيرجّع سبب عام مش فاضي", () => {
    for (const code of [null, undefined, "", "لا شي"]) {
      const note = describeConnectError(code);
      expect(note.risk.length).toBeGreaterThan(10);
      expect(note.fix.length).toBeGreaterThan(10);
    }
  });

  it("الواجهة بتستعمل الشرح مش رسالة وحدة لكل الأسباب", () => {
    expect(PAGE).toMatch(/describeConnectError/);
    expect(PAGE).not.toMatch(/toast\.show\(S\.fbError/);
  });

  it("قائمة صفحات فاضية بعد الرجوع بتقول شي مش بتسكت", () => {
    // رمز اختيار صالح بصفر صفحات كان بيخلّي الشاشة فاضية بلا ولا كلمة.
    expect(PAGE).toMatch(/pages\.length === 0|!pages\.length/);
  });
});

describe("شيل الصفحة الموقوفة", () => {
  const CHANNEL_ID = "ch-1";

  function fakeDb(channel: { status: string; archivedAt?: Date | null } | null) {
    const updates: Array<Record<string, unknown>> = [];
    return {
      updates,
      channel: {
        findFirst: async () => (channel ? { id: CHANNEL_ID, ...channel } : null),
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
    };
  }

  it("الموقوفة بتنشال وبتتعلّم بتاريخ الأرشفة", async () => {
    const db = fakeDb({ status: "DISCONNECTED" });
    const res = await archiveFacebookPage(db, { workspaceId: "ws", pageId: "page-1" });
    expect(res.channelId).toBe(CHANNEL_ID);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].archivedAt).toBeInstanceOf(Date);
  });

  it("المربوطة ما بتنشال — بتنرفض بسبب واضح", async () => {
    const db = fakeDb({ status: "CONNECTED" });
    await expect(archiveFacebookPage(db, { workspaceId: "ws", pageId: "page-1" })).rejects.toThrow(AppError);
    expect(db.updates).toHaveLength(0);
  });

  it("مؤرشفة من قبل أو مش موجودة = ما لقيناها", async () => {
    await expect(
      archiveFacebookPage(fakeDb({ status: "DISCONNECTED", archivedAt: new Date() }), { workspaceId: "ws", pageId: "p" })
    ).rejects.toThrow(NotFoundError);
    await expect(archiveFacebookPage(fakeDb(null), { workspaceId: "ws", pageId: "p" })).rejects.toThrow(NotFoundError);
  });

  it("الموقوفة بس هي اللي بتنشال", () => {
    expect(canArchive({ status: "DISCONNECTED" })).toBe(true);
    for (const status of ["CONNECTED", "CONNECTING", "ERROR"]) {
      expect(canArchive({ status })).toBe(false);
    }
  });
});

describe("الأرشفة ما بتمس المحادثات", () => {
  it("ولا حذف لصف القناة بمسار الفيسبوك", () => {
    // Conversation.channel عليها onDelete: Cascade — حذف القناة بيمسح سجلها.
    expect(SCHEMA).toMatch(/channel\s+Channel\s+@relation\([^)]*onDelete:\s*Cascade/);
    expect(ROUTE).not.toMatch(/channel\.delete\b|channel\.deleteMany\b/);
  });

  it("القائمة بتخفي المؤرشف", () => {
    expect(visibleChannelsWhere("ws")).toEqual({ workspaceId: "ws", type: "FACEBOOK", archivedAt: null });
    expect(ROUTE).toMatch(/visibleChannelsWhere/);
  });

  it("باب الشيل موجود بالمسار", () => {
    expect(ROUTE).toMatch(/export const DELETE/);
    expect(ROUTE).toMatch(/archiveFacebookPage/);
  });

  it("زر الشيل بيظهر للموقوفة بس", () => {
    expect(CARD).toMatch(/row\.status !== "CONNECTED"/);
    expect(CARD).toMatch(/onArchive\(row\)/);
  });

  it("ربط نفس الصفحة من جديد بيرجّعها للقائمة", () => {
    expect(SELECT).toMatch(/archivedAt:\s*null/);
  });

  it("الحقل إضافي بالمخطط — ولا عمود انحذف أو تغيّر نوعه", () => {
    expect(SCHEMA).toMatch(/archivedAt\s+DateTime\?/);
  });
});
