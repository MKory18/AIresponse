/**
 * تشخيص حي لبوابة OpenAI-compatible من بيئة الخادم — بلا تسرّب أسرار
 * (المفتاح يمر بالمعامل فقط، ولا يُطبع ولا يُسجّل):
 *   tsx scripts/probe-live-gateway.ts <base-url> <api-key>
 * 1) GET /v1/models (عدّ + عائلات)  2) POST chat/completions (ping)
 * 3) POST embeddings لمرشّحي نماذج الاندماج + قياس الأبعاد
 */
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
  const [, , baseArg, keyArg] = process.argv;
  if (!baseArg || !keyArg) {
    console.log("USAGE: probe-live-gateway.ts <base-url> <api-key>");
    process.exit(2);
  }
  const root = baseArg.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const key = keyArg.trim();
  // 1) models
  const modelsRes = await fetch(`${root}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  let embeddingish: string[] = [];
  let total = -1;
  if (modelsRes.ok) {
    const j = (await modelsRes.json()) as { data?: { id: string }[] };
    const ids = j.data?.map((m) => m.id) ?? [];
    total = ids.length;
    embeddingish = ids.filter((i) => /embed|embedding/i.test(i));
    console.log(`MODELS total=${total}`);
    for (const id of embeddingish.slice(0, 20)) console.log(`  embed-model: ${id}`);
    if (embeddingish.length === 0) console.log("  (لم يسم أي موديل إندماج بالقائمة)");
  } else {
    console.log(`MODELS HTTP_${modelsRes.status}`);
  }
  // 2) chat
  const chatRes = await fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "auto/chat", messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
  });
  console.log(`CHAT model=auto/chat HTTP_${chatRes.status}`);
  // 3) embeddings candidates
  const candidates = [
    "text-embedding-3-small",
    "openai/text-embedding-3-small",
    "auto/embedding",
    "openai/text-embedding-3-large",
  ];
  for (const model of candidates) {
    try {
      const res = await fetch(`${root}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: "ping" }),
      });
      const text = await res.text();
      let dims = -1;
      if (res.ok) {
        try {
          const j = JSON.parse(text) as { data?: { embedding?: number[] }[] };
          dims = j.data?.[0]?.embedding?.length ?? -1;
        } catch {}
      }
      console.log(`EMBED model=${model} HTTP_${res.status} dims=${dims}`);
    } catch (e) {
      console.log(`EMBED model=${model} NETERR ${String(e).slice(0, 80)}`);
    }
  }
}
main();
