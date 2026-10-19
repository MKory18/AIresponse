/** فحص حالة مزوّد الذكاء لكل مساحة — بلا أسرار. */
import { readFileSync } from "node:fs";
for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) {
    const k = l.slice(0, i).trim();
    const v = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
async function main() {
  const { prisma } = await import("../src/core/db/prisma");
  const rows = await prisma.workspace.findMany({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  const out = [];
  for (const w of rows) {
    const s = await prisma.aISettings.findUnique({
      where: { workspaceId: w.id },
      select: { provider: true, customBaseUrl: true, customApiKeyEnc: true, responseModel: true },
    });
    out.push({
      name: w.name,
      provider: s?.provider ?? "(بلا إعدادات)",
      customBaseUrl: s?.customBaseUrl ?? "-",
      hasKey: Boolean(s?.customApiKeyEnc),
      responseModel: s?.responseModel ?? "-",
    });
  }
  console.log(JSON.stringify(out, null, 1));
  await prisma.$disconnect();
}
main();
