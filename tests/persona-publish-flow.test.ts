/**
 * 3.5ج — «احفظ وانشر» بضغطة وحدة بصفحة الشخصية: مسودة بالقيم المكتوبة ← نشرها (المسار الوحيد اللي بيغيّر الوكيل الحي).
 * الزر بصلاحية `personas.publish` ومعه تنبيه أحمر + «الحل» برتقالي، و«احفظ بدون نشر» بيضل.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createFakeDb } from "./helpers/inmemory-db";
import type { Prisma } from "@prisma/client";
import { createVersion, publishVersion } from "@/modules/ai/persona-versions";

const page = readFileSync("src/app/(dashboard)/personas/page.tsx", "utf8");

describe("صفحة الشخصية", () => {
  it("الزر بصلاحية النشر ومعه تنبيه، والحفظ بلا نشر باقي", () => {
    expect(page).toContain('can("personas.publish")');
    expect(page).toMatch(/value="publish"/);
    expect(page).toContain("احفظ بدون نشر");
    expect(page).toMatch(/<Callout[\s\S]*risk=[\s\S]*fix=/);
    // التسلسل: مسودة بالقيم ← نشر نفس الرقم
    expect(page).toMatch(/versions`, \{ method: "POST"[\s\S]*versions\/\$\{created\.version\}\/publish/);
  });
});

describe("المسودة بقيم مكتوبة ثم النشر", () => {
  it("بتغيّر الوكيل الحي بالقيم الجديدة وبترفع الإصدار، وما بتغيّره قبل النشر", async () => {
    const db = createFakeDb() as unknown as Prisma.TransactionClient & { _stores: Record<string, Array<Record<string, unknown>>> };
    const ctx = { userId: "u1", workspaceId: "ws-persona-pub" };
    const persona = (await (db as any).persona.create({
      data: { workspaceId: ctx.workspaceId, name: "سارة", tone: "friendly", language: "ar", systemInstructions: "قديم", version: 1, isActive: true },
    })) as { id: string };
    const draft = (await createVersion(db as never, ctx, persona.id, { systemInstructions: "جديد" })) as { version: number };
    const live = () => db._stores.persona.find((p) => p.id === persona.id)!;
    expect(live().systemInstructions).toBe("قديم");
    await publishVersion(db as never, ctx, persona.id, draft.version);
    expect(live().systemInstructions).toBe("جديد");
    expect(Number(live().version)).toBeGreaterThan(1);
  });
});
