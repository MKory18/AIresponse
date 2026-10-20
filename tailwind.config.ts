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
        // Fluent 2 brand blue (Microsoft design language).
        // تتبع متغيّرات الثيم — نفس الأزرق بالوضع الفاتح، وتفتيح تلقائي بالداكن.
        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          hover: "rgb(var(--primary-hover) / <alpha-value>)",
          soft: "rgb(var(--primary-soft) / <alpha-value>)",
        },
        brand: {
          50: "#ebf3fc",
          100: "#cfe4fa",
          200: "#b4d6f7",
          300: "#77b7f2",
          400: "#3d95e8",
          500: "#0f6cbd",
          600: "#115ea3",
          700: "#0f548c",
          800: "#0c3b5e",
          900: "#082e4a",
          950: "#051e2f",
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
      boxShadow: {
        xs: "0 1px 2px rgb(0 0 0 / 0.05)",
        card: "0 1px 2px rgb(0 0 0 / 0.05), 0 0 2px rgb(0 0 0 / 0.06)",
        pop: "0 8px 16px rgb(0 0 0 / 0.14)",
        glass: "0 1px 2px rgb(0 0 0 / 0.05), 0 0 2px rgb(0 0 0 / 0.06)",
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