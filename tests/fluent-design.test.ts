import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Fluent (Microsoft-style) design — tokens and shell structure.
 *
 * Pins the redesign's load-bearing decisions so a later edit cannot
 * silently bring back glassmorphism, heavy gradients, floating rounded
 * panels or oversized bubble buttons: flat canvas + surfaces + brand
 * tokens, a flush navigation pane, a flat top command bar, and the
 * shared control sizes.
 */
describe("Fluent design tokens", () => {
  const css = () => read("src/app/globals.css");

  it("defines the light neutral canvas and text scale", () => {
    expect(css()).toContain("--background: 243 243 243");
    expect(css()).toContain("--text: 36 36 36");
    expect(css()).toContain("--text-muted: 97 97 97");
    expect(css()).toContain("--text-subtle: 112 112 112");
    expect(css()).toContain("--line: 224 224 224");
  });

  it("defines the Fluent brand blue and its soft tint", () => {
    expect(css()).toContain("--primary: 15 108 189");
    expect(css()).toContain("--primary-hover: 17 94 163");
    expect(css()).toContain("--primary-soft: 235 243 252");
    expect(css()).toContain("--brand: 15 108 189");
  });

  it("keeps the legacy token names (nothing renders unstyled)", () => {
    for (const name of ["--surface-1", "--surface-2", "--surface-3", "--surface-hover", "--brand:"]) {
      expect(css(), `missing ${name}`).toContain(name);
    }
  });

  it("surfaces are flat — no backdrop blur anywhere in the theme", () => {
    expect(css()).not.toContain("backdrop-filter");
    expect(css()).toContain(".glass-strong {");
  });

  it("primary tint follows the theme instead of a hardcoded light blue", () => {
    // بدون هالربط، bg-primary-soft بيضل أزرق فاتح بالوضع الداكن = نص باهت على خلفية فاتحة.
    const cfg = read("tailwind.config.ts");
    expect(cfg).toContain('soft: "rgb(var(--primary-soft) / <alpha-value>)"');
    expect(cfg).toContain('DEFAULT: "rgb(var(--primary) / <alpha-value>)"');
  });
});

describe("Fluent app shell", () => {
  it("sidebar is a flush navigation pane with a soft active state", () => {
    const src = read("src/components/app-sidebar.tsx");
    expect(src).toContain("bg-surface-2");
    expect(src).toContain("border-e border-line");
    expect(src).toContain("w-[280px]");
    expect(src).toContain("bg-primary-soft");
    expect(src).not.toMatch(/bg-gradient-to-l from-brand-600 via-brand-500/);
    expect(src).not.toContain("backdrop-blur");
  });

  it("topbar is a flat command bar with a muted search field", () => {
    const src = read("src/components/app-shell.tsx");
    expect(src).toContain("h-14");
    expect(src).toContain("bg-surface-2");
    expect(src).toContain("bg-surface-3");
    expect(src).toContain("focus:border-primary");
    expect(src).not.toContain("lg:rounded-[20px]");
  });

  it("primary buttons are solid brand blue, 36px, without gradients", () => {
    const src = read("src/components/ui/button.tsx");
    expect(src).toContain("bg-primary");
    expect(src).toContain("h-9");
    expect(src).not.toContain("bg-gradient");
  });
});

describe("Fluent product grid", () => {
  it("uses a fluid grid, gray image wells and real categories only", () => {
    const src = read("src/app/(dashboard)/products/page.tsx");
    expect(src).toMatch(/xl:grid-cols-3/);
    expect(src).toContain("object-contain");
    expect(src).toContain("bg-surface-3/70");
    // Tabs come from loaded products — no invented category list.
    expect(src).toMatch(/new Set\(products\.map\(\(p\) => p\.category\)/);
  });
});
