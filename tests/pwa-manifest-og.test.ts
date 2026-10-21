import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// `next/font/google` بيحمّل خطوط وقت البناء وما بيشتغل تحت vitest —
// والاختبار بدّه وسوم الصفحة بس، مش الخط.
// ⚠️ كل خط بيستعمله `layout.tsx` لازم ينضاف هون (ثيم جديد بخطه = سطر جديد).
vi.mock("next/font/google", () => ({
  IBM_Plex_Sans_Arabic: () => ({ variable: "--font-arabic", className: "" }),
  Reem_Kufi: () => ({ variable: "--font-reem", className: "" }),
}));

import manifest from "@/app/manifest";
import { metadata, viewport } from "@/app/layout";

/**
 * هوية المنصة على الجوال والمشاركة.
 *
 * ⚠️ شو كان ناقص: ولا بيان تطبيق (PWA) — الموظفة الي بتضيف الموقع لشاشة
 * موبايلها كانت تاخد اسم مقطوع وأيقونة متصفح عامة، والشاشة تفتح بشريط
 * المتصفح كامل مع إن الواجهة جوال-أولًا. وولا بطاقة مشاركة — رابط الموقع
 * ينبعت بواتساب بلا صورة ولا عنوان.
 *
 * `icon.svg` كان موجود من قبل ومنستعمله كما هو — ولا علامة تانية.
 */

describe("بيان التطبيق (PWA)", () => {
  const m = manifest();

  it("الاسم والوصف والاتجاه عربي RTL", () => {
    expect(m.name).toContain("Zaki response");
    expect(m.short_name).toBeTruthy();
    expect(m.lang).toBe("ar");
    expect(m.dir).toBe("rtl");
    expect(m.description).toBeTruthy();
  });

  it("بيفتح كتطبيق مستقل من لوحة التحكم مش من صفحة الدخول", () => {
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/dashboard");
    expect(m.scope).toBe("/");
  });

  it("ألوان الهوية مضبوطة (شريط المتصفح وشاشة الإقلاع)", () => {
    expect(m.theme_color).toBe("#2563eb");
    expect(m.background_color).toBe("#f8fafc");
  });

  it("أيقونة maskable موجودة — بلاها أندرويد بيحطّها بمربّع أبيض بهامش", () => {
    const icons = m.icons ?? [];
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    // كلها تأشّر على نفس العلامة الموجودة — ولا نسخة تانية تنحرف عنها.
    for (const i of icons) expect(i.src).toBe("/icon.svg");
  });
});

describe("وسوم الصفحة والمشاركة", () => {
  it("metadataBase مضبوط — بلاه رابط صورة المشاركة نسبي وبينتجاهل", () => {
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    expect(String(metadata.metadataBase)).toMatch(/^https?:\/\//);
  });

  it("بطاقة المشاركة معرّفة (فيسبوك وواتساب وتويتر)", () => {
    expect(metadata.openGraph).toBeTruthy();
    expect(metadata.openGraph).toMatchObject({ type: "website", locale: "ar" });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("البيان مربوط بالصفحة", () => {
    expect(metadata.manifest).toBe("/manifest.webmanifest");
  });

  it("⚠️ أداة تشغيل داخلية — ممنوع تطلع بنتائج البحث", () => {
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it("themeColor بـ viewport مش بـ metadata (قاعدة Next 14) ومعه فاتح وداكن", () => {
    expect(viewport.themeColor).toBeTruthy();
    const tc = viewport.themeColor as Array<{ media?: string; color: string }>;
    expect(Array.isArray(tc)).toBe(true);
    expect(tc.some((t) => t.media?.includes("dark"))).toBe(true);
    expect(tc.some((t) => t.media?.includes("light"))).toBe(true);
    // ما بيتكرر بالـ metadata — Next بيطلع تحذير وبيتجاهل وحدة منهم.
    expect((metadata as Record<string, unknown>).themeColor).toBeUndefined();
  });
});

describe("الأصول البصرية موجودة ومربوطة", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), "public", "brand", p));

  it("كل الأصول المشار إليها بالكود موجودة فعلًا بـ public/brand", () => {
    for (const f of [
      "og.png",
      "login-art.webp",
      "empty-conversations.webp",
      "empty-orders.webp",
      "empty-products.webp",
      "empty-media.webp",
    ]) {
      expect(() => read(f), `ناقص: ${f}`).not.toThrow();
      expect(read(f).length, `فاضي: ${f}`).toBeGreaterThan(512);
    }
  });

  it("رسمات الحالات الفاضية WebP بخلفية مفرّغة — بلاها مستطيل أبيض بالوضع الداكن", () => {
    for (const f of ["empty-conversations.webp", "empty-orders.webp", "empty-products.webp", "empty-media.webp"]) {
      const b = read(f);
      expect(b.subarray(0, 4).toString("ascii"), `مش WebP: ${f}`).toBe("RIFF");
      expect(b.subarray(8, 12).toString("ascii")).toBe("WEBP");
      // VP8L أو VP8X بتدعم الشفافية؛ VP8 العادي لأ.
      const fourcc = b.subarray(12, 16).toString("ascii");
      expect(["VP8L", "VP8X"], `${f} بصيغة بلا شفافية (${fourcc})`).toContain(fourcc);
    }
  });

  it("⚠️ بطاقة المشاركة PNG مش WebP — بعض المنصّات ما بتقرأ WebP", () => {
    const b = read("og.png");
    expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("البطاقة مربوطة بالوسوم بمقاسها الصحيح", () => {
    const imgs = (metadata.openGraph as { images?: Array<{ url: string; width: number; height: number }> }).images;
    expect(imgs?.[0]).toMatchObject({ url: "/brand/og.png", width: 1200, height: 630 });
  });
});
