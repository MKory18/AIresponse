#!/usr/bin/env node
/**
 * Secret scanning: fails (exit 1) if real-looking secrets appear in tracked
 * source files. Test fixtures use clearly-fake values (e.g. "test-*", *000*)
 * which are allow-listed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".data", "coverage", "dist"]);
const SKIP_FILES = new Set([".env", ".env.local", "package-lock.json", "tsconfig.tsbuildinfo"]);
const ALLOW_PATTERNS = [/test-/i, /0000+/, /placeholder/i, /dummy/i, /fixture/i, /example/i, /xxx+/, /DEMO#/];

const PATTERNS = [
  { name: "Meta App Secret", re: /[0-9a-f]{32}(?![0-9a-f])/ },
  { name: "OpenAI key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "Long-lived FB token", re: /EAAG[A-Za-z0-9]{20,}/ },
  { name: "JWT secret assignment", re: /JWT_SECRET\s*=\s*(?!$)(?=.*[A-Za-z0-9]{32,})/ },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else {
      // مخرجات مكتوبة للمالك (PDF/DOCX) — ثنائية مضغوطة، ما بتطلع أسرار
      // حقيقية، وفحصها كutf8 بيطلع إيجابيات كاذبة.
      if (SKIP_FILES.has(entry) || entry.endsWith(".ico") || entry.endsWith(".png") || entry.endsWith(".pdf") || entry.endsWith(".docx")) continue;
      yield full;
    }
  }
}

let findings = 0;
for (const file of walk(process.cwd())) {
  let content;
  try { content = readFileSync(file, "utf8"); } catch { continue; }
  const lines = content.split("\n");
  for (const p of PATTERNS) {
    lines.forEach((line, i) => {
      if (ALLOW_PATTERNS.some((a) => a.test(line))) return;
      if (p.re.test(line)) {
        console.error(`SECRET?? ${p.name} at ${file}:${i + 1}`);
        findings += 1;
      }
    });
  }
}
if (findings > 0) {
  console.error(`\n${findings} potential secret(s) found. Review each; fake fixtures are allow-listed.`);
  process.exit(1);
}
console.log("Secret scan clean.");
