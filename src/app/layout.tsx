import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-arabic",
  display: "swap",
});

/**
 * ⚠️ `process.env` مباشرة مش `getEnv()`: الـ Dockerfile بيبني بلا أسرار،
 * و`getEnv()` بمستوى الوحدة بيوقف البناء. وبلا `metadataBase` روابط صورة
 * المشاركة تطلع نسبية وفيسبوك وواتساب بيتجاهلوها.
 */
const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "Zaki response",
  description: "Zaki response — منصة المحادثات والمبيعات بالذكاء الاصطناعي",
  applicationName: "Zaki response",
  // بيان التطبيق (`src/app/manifest.ts`) — بدونه ما في تثبيت على الجوال.
  manifest: "/manifest.webmanifest",
  /**
   * ⚠️ بلا صورة لهلّق — `next/og` (ImageResponse) **ما بيبني على ويندوز**:
   * `TypeError: Invalid URL at fileURLToPath` من جوّا `@vercel/og`. وبيئة
   * التطوير عند المالك ويندوز، فما منعتمد على شي ما بينبني عنده.
   * 🔧 الصورة تُولَّد كملف ثابت (البند ٢ بملف برومبتات الصور) وتنحطّ
   * بـ `public/brand/og.png`، وبعدها سطر `images: ["/brand/og.png"]` هون.
   * لهلّق المنصّات بتعرض بطاقة نصية بالعنوان والوصف — أحسن من رابط عريان.
   */
  openGraph: {
    type: "website",
    siteName: "Zaki response",
    locale: "ar",
    title: "Zaki response",
    description: "منصة المحادثات والمبيعات بالذكاء الاصطناعي",
    url: appUrl,
    images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: "Zaki response" }],
  },
  twitter: { card: "summary_large_image", title: "Zaki response" },
  // المنصّة أداة تشغيل داخلية — ما إلها مكان بنتائج البحث.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // ملاحظة: `themeColor` مكانه `viewport` بـ Next 14، مش `metadata`.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
  width: "device-width",
  initialScale: 1,
};

// Applies the saved theme before first paint to avoid a flash.
const themeScript = `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark");}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className={arabic.variable}>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}