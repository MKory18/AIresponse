import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { getSetupProgress, type SetupProgress } from "@/modules/setup/progress";
import { setMockAIProvider } from "@/modules/ai/provider";
import { ROLE_PERMISSIONS, hasPermission } from "@/modules/rbac/permissions";

// `next/link` بيحتاج سياق الراوتر — للاختبار بنرجّعه <a> عادي.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { SetupChecklistView } from "@/components/setup-checklist";

/**
 * خطوات البداية.
 *
 * ⚠️ قبل: ولا دليل بكل الموقع — المستخدم الجديد ما بيعرف من وين يبلّش.
 * 🔧 كل خطوة بتتعلّم «خلصت» من **بيانات المساحة الفعلية**، مش زر بتضغطه.
 */

type Db = Prisma.TransactionClient;
const WS = "ws-setup";
const OTHER = "ws-other";
let db: ReturnType<typeof createFakeDb>;
const progress = (ws = WS) => getSetupProgress(db as Db, ws);
const done = (p: SetupProgress) => Object.fromEntries(p.steps.map((s) => [s.key, s.done]));

const ENV_KEYS = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "HERMES_BASE_URL", "HERMES_API_KEY", "AI_PROVIDER", "NODE_ENV"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  db = createFakeDb();
  setMockAIProvider(undefined);
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "HERMES_BASE_URL", "HERMES_API_KEY", "AI_PROVIDER"]) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function addChannel(status: string, workspaceId = WS) {
  await db.channel.create({
    data: { workspaceId, type: "FACEBOOK", status, displayName: "Page", externalId: `p-${Math.random()}` },
  } as never);
}
async function addProduct(over: Record<string, unknown> = {}, workspaceId = WS) {
  await db.product.create({
    data: { workspaceId, name: "كريم", sku: `S-${Math.random()}`, price: 100, currency: "USD", isActive: true, isArchived: false, ...over },
  } as never);
}
async function setAi(data: Record<string, unknown>, workspaceId = WS) {
  await db.aISettings.create({ data: { workspaceId, ...data } } as never);
}

describe("حساب الخطوات من البيانات الحقيقية", () => {
  it("مساحة جديدة: ولا خطوة خلصت، والجاية «اربط قناة»", async () => {
    const p = await progress();
    expect(p.doneCount).toBe(0);
    expect(p.total).toBe(6);
    expect(p.nextKey).toBe("channel");
    expect(p.complete).toBe(false);
    expect(p.steps.map((s) => s.key)).toEqual(["channel", "products", "persona", "knowledge", "playground", "go-live"]);
  });

  it("قناة «متصلة» فعلًا بس هي الي بتعدّ — مش المنفصلة ولا الي فيها خطأ", async () => {
    await addChannel("DISCONNECTED");
    await addChannel("ERROR");
    await addChannel("CONNECTING");
    expect(done(await progress()).channel).toBe(false);
    await addChannel("CONNECTED");
    expect(done(await progress()).channel).toBe(true);
  });

  it("منتج فعّال بس — المعطّل والمؤرشف ما بيعدّوا", async () => {
    await addProduct({ isActive: false });
    await addProduct({ isArchived: true });
    expect(done(await progress()).products).toBe(false);
    await addProduct();
    expect(done(await progress()).products).toBe(true);
  });

  it("الشخصية: وحدة فعّالة بتكفي، والمعطّلة لا", async () => {
    await db.persona.create({ data: { workspaceId: WS, name: "سارة", isActive: false } } as never);
    expect(done(await progress()).persona).toBe(false);
    await db.persona.create({ data: { workspaceId: WS, name: "ليلى", isActive: true } } as never);
    expect(done(await progress()).persona).toBe(true);
  });

  it("المعرفة: سؤال شائع فعّال أو مستند جاهز بيكفي — المعطّل والي لسا بيتجهّز لا", async () => {
    await db.faq.create({ data: { workspaceId: WS, question: "التوصيل؟", answer: "يومين", isActive: false } } as never);
    await db.knowledgeDocument.create({ data: { workspaceId: WS, title: "سياسة", sourceType: "TEXT", content: "x", status: "PROCESSING" } } as never);
    expect(done(await progress()).knowledge).toBe(false);
    await db.knowledgeDocument.create({ data: { workspaceId: WS, title: "إرجاع", sourceType: "TEXT", content: "x", status: "READY" } } as never);
    expect(done(await progress()).knowledge).toBe(true);
    db = createFakeDb();
    await db.faq.create({ data: { workspaceId: WS, question: "التوصيل؟", answer: "يومين", isActive: true } } as never);
    expect(done(await progress()).knowledge).toBe(true);
  });

  it("التجربة: جلسة ملعب وحدة بتكفي", async () => {
    expect(done(await progress()).playground).toBe(false);
    await db.playgroundSession.create({ data: { workspaceId: WS } } as never);
    expect(done(await progress()).playground).toBe(true);
  });
});

describe("تشغيل الرد الآلي — مزوّد حقيقي بمفتاح فعلًا", () => {
  it("المزوّد التجريبي (الافتراضي) ما بيعدّ حتى لو الرد الآلي مفعّل", async () => {
    await setAi({ provider: "mock", aiEnabled: true, autoRespond: true });
    expect(done(await progress())["go-live"]).toBe(false);
  });

  it("اخترت مزوّد حقيقي بلا مفتاح = لسا ما خلصت (الوكيل ما بيقدر يرد)", async () => {
    await setAi({ provider: "openai", aiEnabled: true, autoRespond: true });
    expect(done(await progress())["go-live"]).toBe(false);
  });

  it("مزوّد حقيقي + مفتاح + الذكاء والرد الآلي مفعّلين = خلصت", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    await setAi({ provider: "openai", aiEnabled: true, autoRespond: true });
    expect(done(await progress())["go-live"]).toBe(true);
  });

  it("الذكاء أو الرد الآلي مطفّي = ما خلصت حتى بمفتاح", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    await setAi({ provider: "openai", aiEnabled: false, autoRespond: true });
    expect(done(await progress())["go-live"]).toBe(false);
    db = createFakeDb();
    await setAi({ provider: "openai", aiEnabled: true, autoRespond: false });
    expect(done(await progress())["go-live"]).toBe(false);
  });
});

describe("الإكمال والترتيب", () => {
  it("الشخصية والمعرفة والتجربة «موصى بها» — ما بيمنعوا إكمال الخطوات الإجبارية", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    await addChannel("CONNECTED");
    await addProduct();
    await setAi({ provider: "openai", aiEnabled: true, autoRespond: true });
    const p = await progress();
    expect(p.complete).toBe(true);
    expect(p.doneCount).toBe(3);
    expect(p.steps.filter((s) => !s.required).map((s) => s.key)).toEqual(["persona", "knowledge", "playground"]);
  });

  it("إجباري ناقص = مش مكتمل، حتى لو الموصى بها كلها خلصت", async () => {
    await addChannel("CONNECTED");
    await db.persona.create({ data: { workspaceId: WS, name: "سارة", isActive: true } } as never);
    await db.playgroundSession.create({ data: { workspaceId: WS } } as never);
    expect((await progress()).complete).toBe(false);
  });

  it("الخطوة الجاية = أول ما خلصت بالترتيب", async () => {
    await addChannel("CONNECTED");
    expect((await progress()).nextKey).toBe("products");
    await addProduct();
    expect((await progress()).nextKey).toBe("persona");
  });

  it("كل شي خلص: ولا خطوة جاية", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    await addChannel("CONNECTED");
    await addProduct();
    await db.persona.create({ data: { workspaceId: WS, name: "سارة", isActive: true } } as never);
    await db.faq.create({ data: { workspaceId: WS, question: "التوصيل؟", answer: "يومين", isActive: true } } as never);
    await db.playgroundSession.create({ data: { workspaceId: WS } } as never);
    await setAi({ provider: "openai", aiEnabled: true, autoRespond: true });
    const p = await progress();
    expect(p.doneCount).toBe(6);
    expect(p.nextKey).toBeNull();
    expect(p.complete).toBe(true);
  });
});

describe("الأمان والعزل", () => {
  it("محصورة بالمساحة: بيانات مساحة تانية ما بتحسب", async () => {
    await addChannel("CONNECTED", OTHER);
    await addProduct({}, OTHER);
    await db.playgroundSession.create({ data: { workspaceId: OTHER } } as never);
    const p = await progress();
    expect(p.doneCount).toBe(0);
    expect(done(await progress(OTHER)).channel).toBe(true);
  });

  it("قراءة بس: ما بتنشئ إعدادات ذكاء (الاستوديو بيعمل upsert، هون لا)", async () => {
    await progress();
    expect(db._stores.aISettings).toHaveLength(0);
  });

  it("الرد أعلام منطقية بلا أرقام ولا أسماء ولا معرّفات", async () => {
    await addChannel("CONNECTED");
    await addProduct();
    const p = await progress();
    for (const s of p.steps) {
      expect(Object.keys(s).sort()).toEqual(["done", "hint", "href", "key", "label", "required"]);
    }
    expect(Object.keys(p).sort()).toEqual(["complete", "doneCount", "nextKey", "steps", "total"]);
  });

  it("المسارات الي بتأشّر عليها الخطوات كلها صفحات فعلية", async () => {
    const hrefs = (await progress()).steps.map((s) => s.href);
    expect(hrefs).toEqual(["/channels", "/products", "/personas", "/knowledge", "/ai/playground", "/settings/ai"]);
  });
});

describe("صلاحية الـ API", () => {
  it("المسار محصور بـ settings.manage (شغلة المالك/المدير)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/setup/progress/route.ts"), "utf8");
    expect(src).toContain('permission: "settings.manage"');
  });

  it("وموظف المبيعات والمشاهد ما عندهم الصلاحية — فالبطاقة ما بتظهرلهم", () => {
    expect(hasPermission("SALES_AGENT", [], "settings.manage")).toBe(false);
    expect(hasPermission("VIEWER", [], "settings.manage")).toBe(false);
    expect(hasPermission("OWNER", [], "settings.manage")).toBe(true);
    expect(Object.keys(ROLE_PERMISSIONS)).toContain("ADMIN");
  });
});

describe("بطاقة الرئيسية", () => {
  const base: SetupProgress = {
    steps: [
      { key: "channel", label: "اربط قناة", hint: "هينت القناة", href: "/channels", done: true, required: true },
      { key: "products", label: "أضف منتجاتك", hint: "هينت المنتجات", href: "/products", done: false, required: true },
      { key: "persona", label: "اضبط شخصية الوكيل", hint: "هينت الشخصية", href: "/personas", done: false, required: false },
      { key: "playground", label: "جرّب الوكيل", hint: "هينت التجربة", href: "/ai/playground", done: false, required: false },
      { key: "go-live", label: "شغّل الرد الآلي", hint: "هينت التشغيل", href: "/settings/ai", done: false, required: true },
    ],
    doneCount: 1,
    total: 5,
    nextKey: "products",
    complete: false,
  };
  const render = (p: SetupProgress, expanded?: boolean) =>
    renderToStaticMarkup(createElement(SetupChecklistView, { progress: p, expanded }));

  it("بتقول الخطوة الجاية بالاسم", () => {
    expect(render(base)).toContain("أضف منتجاتك");
    expect(render(base)).toMatch(/خطوتك الجاية:[\s\S]*أضف منتجاتك/);
  });

  it("خطوة وحدة بس هي «الجاية» (aria-current=step) وبتعرض وصفها وزر «ابدأ»", () => {
    const html = render(base);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain("هينت المنتجات");
    expect(html).toContain("ابدأ");
    // الباهتة ما بتعرض وصفها — بتشتّت.
    expect(html).not.toContain("هينت الشخصية");
    expect(html).not.toContain("هينت التشغيل");
  });

  it("الي خلصت بعلامة وحالتها done، والجاية next، والباقي todo", () => {
    const html = render(base);
    expect(html).toMatch(/data-step="channel"[^>]*data-state="done"|data-state="done"[^>]*data-step="channel"/);
    expect(html).toMatch(/data-step="products"[^>]*data-state="next"|data-state="next"[^>]*data-step="products"/);
    expect(html).toMatch(/data-step="go-live"[^>]*data-state="todo"|data-state="todo"[^>]*data-step="go-live"/);
  });

  it("«اختياري» بس للموصى بها الي لسا ما خلصت", () => {
    const html = render(base);
    expect(html.match(/اختياري/g)).toHaveLength(2); // الشخصية + التجربة
    const withPersonaDone: SetupProgress = {
      ...base,
      steps: base.steps.map((s) => (s.key === "persona" ? { ...s, done: true } : s)),
    };
    expect(render(withPersonaDone).match(/اختياري/g)).toHaveLength(1);
  });

  it("شريط التقدّم معنون لقارئ الشاشة بالقيم الصحيحة", () => {
    const html = render(base);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuemax="5"');
  });

  it("لما تخلص الإجبارية: شريط صغير «النظام جاهز» (مطوي)", () => {
    const complete: SetupProgress = {
      ...base,
      steps: base.steps.map((s) => (s.required ? { ...s, done: true } : s)),
      doneCount: 3,
      nextKey: "persona",
      complete: true,
    };
    const html = render(complete);
    expect(html).toContain("النظام جاهز");
    expect(html).toContain('data-setup="ready"');
    expect(html).not.toContain("خطوتك الجاية");
    expect(html).not.toContain("<ol");
  });

  it("المكتمل لما يتوسّع بيعرض الخطوات (الموصى بها لسا باقية)", () => {
    const complete: SetupProgress = {
      ...base,
      steps: base.steps.map((s) => (s.required ? { ...s, done: true } : s)),
      doneCount: 3,
      nextKey: "persona",
      complete: true,
    };
    const html = render(complete, true);
    expect(html).toContain("<ol");
    expect(html).toContain("اضبط شخصية الوكيل");
  });
});
