import type { MetadataRoute } from "next";

/**
 * بيان التطبيق (PWA). كان ناقص كليًا: الموظفة الي بتضيف الموقع لشاشة
 * موبايلها كانت تاخد أيقونة متصفح عامة واسم مقطوع، والشاشة تفتح بشريط
 * المتصفح كامل — مع إن الواجهة مصمّمة جوال-أولًا.
 *
 * الأيقونة هي `src/app/icon.svg` نفسها (مسار `/icon.svg` الي Next بيخدمه)
 * — ولا ملف صورة جديد بالريبو، ولا نسخة تانية من العلامة تنحرف عنها.
 *
 * `purpose: "maskable"` ضروري لأندرويد: بلاها النظام بيحطّ الأيقونة جوّا
 * مربّع أبيض بهامش، وبتطلع أصغر من كل الأيقونات حولها.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Zaki response — منصة المحادثات والمبيعات",
    short_name: "Zaki response",
    description: "محرك المحادثات والمبيعات بالذكاء الاصطناعي",
    lang: "ar",
    dir: "rtl",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f8fafc",
    theme_color: "#2563eb",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "maskable" },
    ],
  };
}
