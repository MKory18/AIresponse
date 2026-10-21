import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // tsconfig بيضبط `jsx: preserve` (لـ Next) — فبلا هالسطر esbuild بيترجم JSX
  // بالطريقة القديمة وأي مكوّن بيتعرض بالاختبار بيرمي «React is not defined».
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
