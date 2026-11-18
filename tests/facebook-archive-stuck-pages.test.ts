/**
 * «شيلها من القائمة» لازم تشتغل على كل صفحة مش مربوطة — مش الموقوفة بس.
 *
 * ⚠️ الزر كان بيظهر لما `status !== "CONNECTED"` (يعني كمان `ERROR` و`CONNECTING`)،
 * بس الخادم كان بيقبل `DISCONNECTED` لحالها ويرد 422 «الصفحة لسا مربوطة».
 * فصفحة علقت بـ`ERROR` أو `CONNECTING` — وهاي بالضبط اللي بتخلّفها محاولة ربط
 * فاشلة — بيطلعلها الخيار وما بيشتغل. المالك بيكبس وبيرجعله رفض بلا معنى.
 * 🔧 القاعدة وحدة بالمكانين: أي صفحة **مش** `CONNECTED` بتنشال. والنية محفوظة —
 * صفحة شغّالة وبترد على الزبائن ما بتختفي من عين المالك.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archiveFacebookPage, canArchive, visibleChannelsWhere } from "@/modules/channels/facebook/archive";
import { AppError, NotFoundError } from "@/core/errors";

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const CARD = readFileSync(join(ROOT, "src/app/(dashboard)/channels/v2/channel-card.tsx"), "utf8");

/** كل الحالات من المخطط — عشان حالة جديدة ما تمرق بصمت. */
function schemaStatuses(): string[] {
  const block = /enum ChannelStatus \{([^}]*)\}/.exec(SCHEMA);
  if (!block) throw new Error("ChannelStatus enum not found");
  return block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"));
}

function fakeDb(channel: { status: string; archivedAt?: Date | null } | null) {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    channel: {
      findFirst: async () => (channel ? { id: "ch-1", ...channel } : null),
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return {};
      },
    },
  };
}

describe("الخيار بيشتغل على كل صفحة مش مربوطة", () => {
  it("الحالات كلها معروفة — ولا وحدة جديدة مرقت", () => {
    expect(schemaStatuses().sort()).toEqual(["CONNECTED", "CONNECTING", "DISCONNECTED", "ERROR"]);
  });

  it("القاعدة: أي حالة غير CONNECTED بتنشال", () => {
    for (const status of schemaStatuses()) {
      expect(canArchive({ status })).toBe(status !== "CONNECTED");
    }
  });

  it("صفحة علقت بـERROR بتنشال فعلًا", async () => {
    // ⚠️ هاي اللي بتخلّفها محاولة ربط فاشلة — وهي اللي كان الخيار بيرفضها.
    const db = fakeDb({ status: "ERROR" });
    const res = await archiveFacebookPage(db, { workspaceId: "ws", pageId: "page-1" });
    expect(res.channelId).toBe("ch-1");
    expect(db.updates[0].archivedAt).toBeInstanceOf(Date);
  });

  it("صفحة علقت بـCONNECTING بتنشال فعلًا", async () => {
    const db = fakeDb({ status: "CONNECTING" });
    await archiveFacebookPage(db, { workspaceId: "ws", pageId: "page-1" });
    expect(db.updates).toHaveLength(1);
  });

  it("الموقوفة بتضل تنشال زي ما كانت", async () => {
    const db = fakeDb({ status: "DISCONNECTED" });
    await archiveFacebookPage(db, { workspaceId: "ws", pageId: "page-1" });
    expect(db.updates).toHaveLength(1);
  });

  it("المربوطة لحالها بترفض — وبسبب واضح", async () => {
    const db = fakeDb({ status: "CONNECTED" });
    await expect(archiveFacebookPage(db, { workspaceId: "ws", pageId: "p" })).rejects.toThrow(AppError);
    expect(db.updates).toHaveLength(0);
  });

  it("مؤرشفة من قبل أو مش موجودة = ما لقيناها", async () => {
    await expect(
      archiveFacebookPage(fakeDb({ status: "ERROR", archivedAt: new Date() }), { workspaceId: "ws", pageId: "p" })
    ).rejects.toThrow(NotFoundError);
    await expect(archiveFacebookPage(fakeDb(null), { workspaceId: "ws", pageId: "p" })).rejects.toThrow(NotFoundError);
  });
});

describe("الواجهة والخادم على نفس القاعدة", () => {
  it("شرط الزر بالبطاقة هو نفسه شرط الخادم", () => {
    // لو اختلفوا، بيرجع نفس العطل: زر بيظهر وما بيشتغل.
    expect(CARD).toMatch(/row\.status !== "CONNECTED"/);
    expect(canArchive({ status: "ERROR" })).toBe(true);
    expect(canArchive({ status: "CONNECTING" })).toBe(true);
  });

  it("القائمة لسا بتخفي المؤرشف", () => {
    expect(visibleChannelsWhere("ws")).toEqual({ workspaceId: "ws", type: "FACEBOOK", archivedAt: null });
  });
});
