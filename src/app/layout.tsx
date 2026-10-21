import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic, Reem_Kufi } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-arabic",
  display: "swap",
});

/**
 * خط عناوين الثيم الإسلامي (كوفي). `preload: false`: ما بينزل إلا لما صفحة بتستعمله
 * فعلًا — الثيم الافتراضي ما بيعرّف `--font-display` فما بيطلبه ولا بحمّل بايت زيادة.
 */
const reem = Reem_Kufi({
  subsets: ["arabic"],
  variable: "--font-reem",
  display: "swap",
  preload: false,
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

// Applies the saved theme (data-theme) and scheme (.dark) before first paint to
// avoid a flash — built from the same THEMES table as `resolveTheme`.
const themeScript = THEME_INIT_SCRIPT;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className={`${arabic.variable} ${reem.variable}`}>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}