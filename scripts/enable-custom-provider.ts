/**
 * أداة تشغيل واحد لمساحة المالك — تمكين مزوّد مخصص (custom) مباشرة:
 *   tsx scripts/enable-custom-provider.ts <base-url> <api-key> [model]
 *
 * المفتاح بيمشّي بالمعامل فقط (ما بيتكتب بملف ولا بسجل)، وبيتخزن
 * بالقاعدة مشفّراً AES-256-GCM فقط. فحص اتصال حي بعد الحفظ.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) {
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
import { prisma } from "../src/core/db/prisma";
import { encryptSecret } from "../src/core/crypto";
import { validateCustomEndpoint } from "../src/modules/ai/endpoint-guard";
import { normalizeHermesEndpoint, probeProviderEndpoint } from "../src/modules/ai/provider";

async function main() {
  const [, , baseArg, keyArg, modelArg] = process.argv;
  if (!baseArg || !keyArg) {
    console.log("USAGE: enable-custom-provider.ts <base-url> <api-key> [model]");
    process.exit(2);
  }
  const endpoint = normalizeHermesEndpoint(baseArg.trim());
  const guard = validateCustomEndpoint(endpoint);
  if (!guard.ok) {
    console.log(`GUARD_REJECTED ${guard.reason}`);
    process.exit(2);
  }
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (!ws) {
    console.log("NO_WORKSPACE");
    process.exit(2);
  }
  await prisma.aISettings.upsert({
    where: { workspaceId: ws.id },
    create: {
      workspaceId: ws.id,
      provider: "custom",
      customBaseUrl: baseArg.trim(),
      customApiKeyEnc: encryptSecret(keyArg.trim()),
      ...(modelArg ? { responseModel: modelArg } : {}),
    },
    update: {
      provider: "custom",
      customBaseUrl: baseArg.trim(),
      customApiKeyEnc: encryptSecret(keyArg.trim()),
      ...(modelArg ? { responseModel: modelArg } : {}),
    },
  });
  console.log(`SAVED workspace="${ws.name}" endpoint=${endpoint}`);
  const models = modelArg ? [modelArg] : ["glm-4.6", "glm-4.5", "glm-4-flash", "gpt-4o-mini"];
  for (const model of models) {
    const probe = await probeProviderEndpoint(endpoint, keyArg.trim(), model, { followRedirects: false, timeoutMs: 15000 });
    console.log(`PROBE model=${model} ok=${probe.ok} ${probe.detail} ${probe.latencyMs}ms`);
    if (probe.ok) break;
  }
}
main().finally(() => prisma.$disconnect());
