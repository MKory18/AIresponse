import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f7ff",
          100: "#dcecff",
          500: "#2f6feb",
          600: "#2458c9",
          700: "#1d47a3",
        },
      },
    },
  },
  plugins: [],
};

export default config;
