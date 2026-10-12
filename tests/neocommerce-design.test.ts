import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * NeoCommerce calm theme — tokens and shell structure.
 *
 * Pins the redesign's load-bearing decisions so a later edit cannot
 * silently bring back heavy gradients, dark sidebars or tiny buttons:
 * canvas + surfaces + primary tokens, the floating white sidebar with a
 * soft active state, the white topbar, and the shared control sizes.
 */
describe("NeoCommerce design tokens", () => {
  const css = () => read("src/app/globals.css");

  it("defines the calm canvas and text scale", () => {
    expect(css()).toContain("--background: 238 240 245");
    expect(css()).toContain("--text: 21 21 21");
    expect(css()).toContain("--text-muted: 102 102 109");
    expect(css()).toContain("--text-subtle: 146 146 154");
    expect(css()).toContain("--line: 236 236 241");
  });

  it("defines the primary action blue and its soft tint", () => {
    expect(css()).toContain("--primary: 64 88 243");
    expect(css()).toContain("--primary-hover: 52 74 224");
    expect(css()).toContain("--primary-soft: 238 237 255");
  });

  it("keeps the legacy token names (nothing renders unstyled)", () => {
    for (const name of ["--surface-1", "--surface-2", "--surface-3", "--surface-hover", "--brand:"]) {
      expect(css(), `missing ${name}`).toContain(name);
    }
  });
});

describe("NeoCommerce app shell", () => {
  it("sidebar is a floating white card with a soft active state", () => {
    const src = read("src/components/app-sidebar.tsx");
    expect(src).toContain("bg-surface-2");
    expect(src).toContain("rounded-[28px]");
    expect(src).toContain("w-80");
    expect(src).toContain("bg-primary-soft");
    expect(src).not.toMatch(/bg-gradient-to-l from-brand-600 via-brand-500/);
  });

  it("topbar is a white rounded bar with a muted search field", () => {
    const src = read("src/components/app-shell.tsx");
    expect(src).toContain("lg:h-20");
    expect(src).toContain("lg:rounded-[20px]");
    expect(src).toContain("bg-surface-3/80");
    expect(src).toContain("focus:border-primary");
  });

  it("primary buttons are solid blue, 48px, without gradients", () => {
    const src = read("src/components/ui/button.tsx");
    expect(src).toContain("bg-primary");
    expect(src).toContain("h-11");
    expect(src).not.toContain("bg-gradient");
  });
});

describe("NeoCommerce product grid", () => {
  it("uses a fluid grid, gray image wells and real categories only", () => {
    const src = read("src/app/(dashboard)/products/page.tsx");
    expect(src).toMatch(/xl:grid-cols-3/);
    expect(src).toContain("object-contain");
    expect(src).toContain("bg-surface-3/70");
    // Tabs come from loaded products — no invented category list.
    expect(src).toMatch(/new Set\(products\.map\(\(p\) => p\.category\)/);
  });
});
