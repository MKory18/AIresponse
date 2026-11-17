import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Callout } from "@/components/ui/callout";
import { CountBadge } from "@/components/ui/count-badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip, TONES } from "@/components/ui/status-chip";
import { Switch } from "@/components/ui/switch";
import { DateTime, Money, Num } from "@/components/ui/formatted";
import { ApiError, FORBIDDEN_MESSAGE, api, messageForError } from "@/lib/api-client";
import { newUiFiles } from "./helpers/new-ui-files";

/**
 * 2.1 — نظام التصميم: أدوار الألوان بـTailwind · السلّم · منع اللوحة الثابتة بملفات الواجهة الجديدة · سلوك العدّة.
 * (اكتمال الأدوار بكل ثيم وتباينها: `theme-system.test.ts`.)
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("tailwind: أدوار الواجهة الجديدة", () => {
  const tw = read("tailwind.config.ts");
  it("ألوان الحالة والتعبئة والشريط والتركيز من متغيّرات CSS", () => {
    for (const role of ["success", "warning", "danger", "info"]) {
      expect(tw).toMatch(new RegExp(`${role}: \\{ DEFAULT: "rgb\\(var\\(--${role}\\)[^}]*soft: "rgb\\(var\\(--${role}-soft\\)`));
    }
    for (const v of ["--on-primary", "--border-strong", "--focus", "--sidebar", "--sidebar-fg"]) expect(tw).toContain(`var(${v})`);
  });
  it("الزوايا والارتفاعات والسلّم بأسماء صريحة", () => {
    expect(tw).toMatch(/control: "6px"/);
    expect(tw).toMatch(/card: "10px"/);
    expect(tw).toMatch(/sheet: "16px"/);
    expect(tw).toMatch(/raised:/);
    expect(tw).toMatch(/overlay:/);
    expect(tw).toMatch(/caption: \["13px"/);
    expect(tw).toMatch(/display: \["32px"/);
    expect(tw).toContain("cubic-bezier(0.2, 0, 0.1, 1)");
  });
  it("زر الأساسي بنص `on-primary` (بالداكن مش دايمًا أبيض)", () => {
    expect(read("src/components/ui/button.tsx")).toMatch(/bg-primary text-on-primary/);
  });
});

describe("ملفات الواجهة الجديدة: أدوار بس", () => {
  const PALETTE = /\b(?:text|bg|border|ring|fill|stroke|from|to|via|divide|outline|shadow)-(?:red|green|emerald|amber|yellow|orange|sky|blue|indigo|slate|gray|zinc|neutral|stone|rose|pink|purple|violet|teal|cyan|lime|fuchsia|white|black)(?:-\d{2,3})?(?:\/\d+)?\b/;
  const ARBITRARY_PX = /text-\[\d+(?:\.\d+)?px\]/;
  const HEX = /(?:bg|text|border|ring|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]/;

  it("ولا لوحة ثابتة ولا hex ولا `text-[Npx]`", () => {
    const hits: string[] = [];
    for (const f of newUiFiles()) {
      if (!existsSync(f)) continue;
      const code = read(relative(process.cwd(), f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const re of [PALETTE, ARBITRARY_PX, HEX]) {
        const m = code.match(re);
        if (m) hits.push(`${relative(process.cwd(), f)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("المعرض `/dev/ui` بالتطوير بس وبرّا (dashboard)", () => {
    const page = read("src/app/dev/ui/page.tsx");
    expect(page).toContain("notFound()");
    expect(page).toMatch(/NODE_ENV === "production"/);
    expect(existsSync(join(process.cwd(), "src/app/(dashboard)/dev"))).toBe(false);
  });
});

describe("Switch · SegmentedControl", () => {
  it("Switch: role=switch وaria-checked والحالة بالنص مش باللون بس", () => {
    const on = html(createElement(Switch, { checked: true, onChange: () => {}, label: "الوكيل" }));
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("شغّال");
    const off = html(createElement(Switch, { checked: false, onChange: () => {}, label: "الوكيل", disabled: true }));
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain("متوقف");
    expect(off).toContain("disabled");
  });
  it("SegmentedControl: radiogroup معنون، المختار بس aria-checked وtabIndex=0", () => {
    const out = html(
      createElement(SegmentedControl<"a" | "b">, {
        label: "الحالة",
        value: "a",
        onChange: () => {},
        options: [
          { value: "a", label: "أ" },
          { value: "b", label: "ب" },
        ],
      })
    );
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('aria-label="الحالة"');
    expect(out.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(out.match(/tabindex="0"/g)?.length).toBe(1);
  });
});

describe("StatusChip · CountBadge", () => {
  it("كل نبرة بأيقونة ونصها، والنبرة بسمة", () => {
    for (const tone of TONES) {
      const out = html(createElement(StatusChip, { tone }, "نص"));
      expect(out).toContain(`data-tone="${tone}"`);
      expect(out).toContain("<svg");
      expect(out).toContain("نص");
    }
    expect(html(createElement(StatusChip, { tone: "danger", icon: false }, "نص"))).not.toContain("<svg");
  });
  it("الصفر بيختفي، فوق الحد «99+»، والأرقام لاتينية", () => {
    expect(html(createElement(CountBadge, { count: 0 }))).toBe("");
    expect(html(createElement(CountBadge, { count: 0, showZero: true }))).toContain(">0<");
    expect(html(createElement(CountBadge, { count: 240 }))).toContain("99+");
    expect(html(createElement(CountBadge, { count: 7 }))).toContain(">7<");
    expect(html(createElement(CountBadge, { count: -1 }))).toBe("");
  });
});

describe("DataTable", () => {
  interface R {
    id: string;
    name: string;
  }
  const cols: Column<R>[] = [{ key: "name", header: "الاسم", cell: (r) => r.name }];
  const rows: R[] = [
    { id: "1", name: "أ" },
    { id: "2", name: "ب" },
  ];
  const base = { columns: cols, rowKey: (r: R) => r.id };

  it("العدد الكلي من الخادم + «تحميل المزيد» بس لما في أكتر", () => {
    const more = html(createElement(DataTable<R>, { ...base, rows, total: 40, onLoadMore: () => {} }));
    expect(more).toContain("عرض 2 من 40");
    expect(more).toContain("حمّل المزيد");
    const all = html(createElement(DataTable<R>, { ...base, rows, total: 2, onLoadMore: () => {} }));
    expect(all).toContain("عرض 2 من 2");
    expect(all).not.toContain("حمّل المزيد");
  });
  it("تحميل = هياكل بلا صفوف حقيقية", () => {
    const out = html(createElement(DataTable<R>, { ...base, rows, loading: true }));
    expect(out).toContain("data-skeleton-row");
    expect(out).not.toContain(">أ<");
  });
  it("فراغ = حاوية الفراغ بالنص المعطى (بلا تذييل عدّ)", () => {
    const out = html(createElement(DataTable<R>, { ...base, rows: [], total: 0, empty: createElement("p", null, "ما في شي") }));
    expect(out).toContain("data-table-empty");
    expect(out).toContain("ما في شي");
    expect(out).not.toContain("data-table-count");
  });
  it("الصف القابل للنقر بيوصل بالكيبورد، ورؤوس الأعمدة scope=col", () => {
    const out = html(createElement(DataTable<R>, { ...base, rows, onRowClick: () => {}, caption: "جدول" }));
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('scope="col"');
    expect(out).toContain("sr-only");
  });
});

describe("Callout · IconButton · formatted", () => {
  it("الخطر أحمر «تنبيه» وتحته «الحل» (قاعدة المالك)", () => {
    const out = html(createElement(Callout, { risk: "خطر", fix: "حل" }));
    expect(out.indexOf("تنبيه")).toBeGreaterThan(-1);
    expect(out.indexOf("الحل")).toBeGreaterThan(out.indexOf("تنبيه"));
    expect(out).toContain('data-callout="risk"');
    expect(out).toContain('data-callout="fix"');
    expect(out).toContain('role="alert"');
  });
  it("قابل للطي بـ<details> مفتوح افتراضيًا", () => {
    expect(html(createElement(Callout, { risk: "x", collapsible: true }))).toMatch(/<details[^>]*open/);
  });
  it("IconButton: aria-label إلزامي وبيطلع تلميحة", () => {
    const out = html(createElement(IconButton, { "aria-label": "تعديل" }, "x"));
    expect(out).toContain('aria-label="تعديل"');
    expect(out).toContain('role="tooltip"');
    expect(out).toContain("تعديل");
  });
  it("Money · Num · DateTime بتنسيق lib/format", () => {
    expect(html(createElement(Money, { amount: 12.5, currency: "JOD" }))).toContain("12.5 د.أ");
    expect(html(createElement(Num, { value: 1234 }))).toContain("1,234");
    const dt = html(createElement(DateTime, { value: "2026-11-17T22:30:00Z", timeZone: "UTC", mode: "time" }));
    expect(dt).toContain("22:30");
    expect(dt).toContain('dateTime="2026-11-17T22:30:00.000Z"');
  });
});

describe("api-client", () => {
  const res = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  it("403 دايمًا نفس الجملة العربية", () => {
    expect(messageForError(403, { error: "ANYTHING", message: "x" })).toBe(FORBIDDEN_MESSAGE);
  });
  it("رمز معروف من الخريطة، رسالة عربية من الخادم تنعرض، وغيرها عامة", () => {
    expect(messageForError(400, { error: "CANNOT_GRANT" })).toMatch(/ما بتقدر تمنح/);
    expect(messageForError(400, { message: "الاسم مطلوب" })).toBe("الاسم مطلوب");
    expect(messageForError(400, { message: "English only" })).toBe("فشل الطلب");
    expect(messageForError(500, null)).toMatch(/خطأ عندنا/);
  });
  it("نجاح بيرجّع JSON، وفشل بيرمي ApiError بالحالة والرمز", async () => {
    await expect(api("/x", { fetcher: res(200, { a: 1 }) as never })).resolves.toEqual({ a: 1 });
    const err = await api("/x", { fetcher: res(422, { error: "PERMISSION_NOT_GRANTABLE" }) as never }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("PERMISSION_NOT_GRANTABLE");
  });
  it("انقطاع الشبكة = رسالة عربية مش استثناء خام", async () => {
    const err = await api("/x", {
      fetcher: (async () => {
        throw new TypeError("fetch failed");
      }) as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("تعذّر الاتصال بالخادم");
  });
  it("جسم JSON بيتحوّل وبيتحط له Content-Type", async () => {
    let seen: RequestInit | undefined;
    await api("/x", {
      json: { a: 1 },
      method: "POST",
      fetcher: (async (_p: string, init: RequestInit) => {
        seen = init;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    expect(seen?.body).toBe('{"a":1}');
    expect((seen?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
