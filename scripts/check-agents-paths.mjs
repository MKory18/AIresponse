#!/usr/bin/env node
// الحزمة 0.2: ولا ملف/مسار مذكور بـ AGENTS.md مش موجود بالكود.
// بيقرا كل ما بين `backticks` بـ AGENTS.md اللي بيبدأ بجذر معروف (src/ tests/ docs/ …)
// وبيتأكد إنه موجود (وبيدعم * بآخر الاسم). الشرح اللي فيه مسافات بيتخطّى.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "tests", "docs", "scripts", "contracts", "prisma", "public", ".github"];
const md = readFileSync(join(root, process.argv[2] ?? "AGENTS.md"), "utf8");

function exists(p) {
  const abs = join(root, p);
  if (!p.includes("*")) return existsSync(abs);
  const dir = dirname(abs);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  const esc = (s) => s.replace(/[^A-Za-z0-9_-]/g, (c) => "[" + c + "]");
  const re = new RegExp("^" + base.split("*").map(esc).join(".*") + "$");
  return readdirSync(dir).some((f) => re.test(f));
}

const missing = new Set();
let checked = 0;
for (const m of md.matchAll(/`([^`\n]+)`/g)) {
  const span = m[1].trim();
  if (/\s/.test(span) || !ROOTS.some((r) => span.startsWith(r + "/"))) continue;
  checked++;
  if (!exists(span)) missing.add(span);
}

if (missing.size) {
  console.error(`AGENTS.md يذكر ${missing.size} مسار مش موجود بالكود:`);
  for (const p of [...missing].sort()) console.error("  - " + p);
  process.exit(1);
}
console.log(`AGENTS.md paths OK (${checked} checked).`);
