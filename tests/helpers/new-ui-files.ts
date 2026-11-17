import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** ملفات الواجهة الجديدة (قواعدها أشد من القديمة لحد حزمة 3.8): عدّة 2.1 + أي ملف تحت مجلد `v2`. */
export function newUiFiles(): string[] {
  const kit = [
    "switch", "segmented-control", "status-chip", "count-badge", "data-table", "icon-button", "tooltip", "menu", "callout",
    "countdown", "evidence-link", "formatted",
  ].map((n) => join(ROOT, "src", "components", "ui", `${n}.tsx`));
  const v2 = [...walk(join(ROOT, "src", "app")), ...walk(join(ROOT, "src", "components"))].filter((f) =>
    relative(ROOT, f).split(sep).includes("v2")
  );
  const attention = ["attention-panel.tsx", "health-banner.tsx", "use-attention.ts"].map((n) => join(ROOT, "src", "components", "attention", n));
  return [...kit, ...attention, ...v2, join(ROOT, "src", "app", "dev", "ui", "gallery.tsx"), join(ROOT, "src", "lib", "api-client.ts")];
}
