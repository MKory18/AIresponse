import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-arabic)", "Segoe UI", "Segoe UI Variable", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        // Fluent 2 brand blue (Microsoft design language) — **بمتغيّرات CSS**.
        //
        // ⚠️ قبل: `primary` و`brand-*` كانت ألوان hex ثابتة — فأي ثيم ما كان
        // قادر يبدّلها، وبالوضع الداكن `bg-primary-soft` ضل فاتح (أبيض مزرق):
        // بند القائمة النشط طلع مستطيل أبيض بنص باهت.
        // 🔧 هلأ بتقرا `--primary*` و`--brand-N` من globals.css. قيم الثيم
        // الافتراضي بتطابق الـhex القديم بالحرف، فما بيتغيّر بكسل بالفاتح.
        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          hover: "rgb(var(--primary-hover) / <alpha-value>)",
          soft: "rgb(var(--primary-soft) / <alpha-value>)",
        },
        // لون التمييز الزخرفي (ذهبي/سماوي حسب الثيم) — للخطوط والزخارف، مش للنص.
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          // نسخة بتنقرا كنص (تباين ≥ 4.5:1 على السطح).
          fg: "rgb(var(--accent-fg) / <alpha-value>)",
        },
        // لوحة الدخول الجانبية (كانت لون ثابت `bg-[…]` مش قابل للثيم).
        showcase: "rgb(var(--showcase) / <alpha-value>)",
        // علامة Zaki: تدرّج + شرارة (كانت sky-400/blue-800/sky-200 ثابتة).
        logo: {
          from: "rgb(var(--logo-from) / <alpha-value>)",
          via: "rgb(var(--logo-via) / <alpha-value>)",
          to: "rgb(var(--logo-to) / <alpha-value>)",
          spark: "rgb(var(--logo-spark) / <alpha-value>)",
        },
        brand: {
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          300: "rgb(var(--brand-300) / <alpha-value>)",
          400: "rgb(var(--brand-400) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
          800: "rgb(var(--brand-800) / <alpha-value>)",
          900: "rgb(var(--brand-900) / <alpha-value>)",
          950: "rgb(var(--brand-950) / <alpha-value>)",
        },
        surface: {
          1: "rgb(var(--surface-1) / <alpha-value>)",
          2: "rgb(var(--surface-2) / <alpha-value>)",
          3: "rgb(var(--surface-3) / <alpha-value>)",
          hover: "rgb(var(--surface-hover) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--text) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
          subtle: "rgb(var(--text-subtle) / <alpha-value>)",
        },
        line: "rgb(var(--line) / <alpha-value>)",
      },
      // `text-primary` = لون النص/الأيقونة على السطح (فاتح بالداكن)، مش لون
      // تعبئة الزر. `bg-primary` و`border-primary` بيضلّوا على `--primary`.
      textColor: {
        primary: {
          DEFAULT: "rgb(var(--primary-fg) / <alpha-value>)",
          hover: "rgb(var(--primary-hover) / <alpha-value>)",
          soft: "rgb(var(--primary-soft) / <alpha-value>)",
        },
      },
      boxShadow: {
        xs: "0 1px 2px rgb(0 0 0 / 0.05)",
        // الثيمات بتبدّل الظل (توهّج نيون بالمدينة الليلية) — الافتراضي نفس القديم.
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
        glass: "var(--shadow-card)",
        glow: "0 0 0 1px rgb(15 108 189 / 0.25)",
      },
      // Fluent radii: controls 4px · surfaces 8px · dialogs 12px.
      borderRadius: {
        xl2: "1rem",
        lg: "4px",
        xl: "6px",
        "2xl": "8px",
        "3xl": "12px",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1" } },
        "slide-in": { from: { opacity: "0", transform: "translateX(16px)" }, to: { opacity: "1", transform: "translateX(0)" } },
        "scale-in": { from: { opacity: "0", transform: "scale(0.97)" }, to: { opacity: "1", transform: "scale(1)" } },
        shimmer: { "100%": { transform: "translateX(-100%)" } },
      },
      animation: {
        "fade-in": "fade-in 0.18s ease-out",
        "slide-in": "slide-in 0.2s ease-out",
        "scale-in": "scale-in 0.16s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;