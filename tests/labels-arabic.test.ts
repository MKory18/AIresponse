import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LABELS } from "@/lib/i18n";

/**
 * كل حالة بتنعرض بالواجهة إلها اسم عربي.
 *
 * ⚠️ قبل: CLAIMED · READY · ACTIVE · ROLLED_BACK وتصنيفات الوسائط والمعرفة كانت تطلع
 * خام بالإنجليزي (`label()` بيرجّع المفتاح لما يكون ناقص).
 * 🔧 أي قيمة جديدة بهالأنواع لازم تنضاف لـ`LABELS` — وإلا الاختبار بيفشل.
 */

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
function enumValues(name: string): string[] {
  const m = new RegExp(`enum ${name} \{([^}]*)\}`).exec(schema);
  expect(m, `enum ${name}`).not.toBeNull();
  return m![1]!
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
}

const DISPLAYED = [
  "HandoffStatus",
  "CampaignStatus",
  "CampaignRecipientStatus",
  "CampaignEventType",
  "MediaCategory",
  "KnowledgeCategory",
  "KnowledgeStatus",
  "FollowUpStatus",
];

describe("أسماء عربية لكل حالة معروضة", () => {
  it.each(DISPLAYED)("%s", (name) => {
    const missing = enumValues(name).filter((v) => !LABELS[v] || !/[؀-ۿ]/.test(LABELS[v]!));
    expect(missing, `بلا اسم عربي: ${missing.join(" ")}`).toEqual([]);
  });

  it("سجل الطلب: كل إجراء بيسجّله الطلب إله اسم عربي", () => {
    for (const a of ["order.created", "order.cancelled", "order.state_changed", "order.updated_from_chat", "order.deleted"]) {
      expect(LABELS[a], a).toMatch(/[؀-ۿ]/);
    }
  });
});
