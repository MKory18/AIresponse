import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-arabic)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        // Primary — blue (kept from existing brand identity, extended scale)
        brand: {
          50: "#eef5fe",
          100: "#d9e9fd",
          200: "#bcd7fb",
          300: "#8dbdf8",
          400: "#5899f1",
          500: "#2f6feb",
          600: "#1d55d1",
          700: "#1844a8",
          800: "#173a86",
          900: "#17326b",
          950: "#122043",
        },
        surface: {
          1: "rgb(var(--surface-1) / <alpha-value>)",
          2: "rgb(var(--surface-2) / <alpha-value>)",
          3: "rgb(var(--surface-3) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--text) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
          subtle: "rgb(var(--text-subtle) / <alpha-value>)",
        },
        line: "rgb(var(--line) / <alpha-value>)",
      },
      boxShadow: {
        xs: "0 1px 2px rgb(0 0 0 / 0.04)",
        card: "0 1px 2px rgb(16 24 40 / 0.04), 0 1px 3px rgb(16 24 40 / 0.06)",
        pop: "0 8px 24px rgb(16 24 40 / 0.12)",
      },
      borderRadius: { xl2: "1rem" },
      keyframes: {
        "fade-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1" } },
        "slide-in": { from: { opacity: "0", transform: "translateX(16px)" }, to: { opacity: "1", transform: "translateX(0)" } },
        shimmer: { "100%": { transform: "translateX(-100%)" } },
      },
      animation: {
        "fade-in": "fade-in 0.18s ease-out",
        "slide-in": "slide-in 0.2s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;