/**
 * P16 — مقياس محلي لجدولة مهام الرد (قاعدة بالذاكرة + تأخير مزوّد مُحاكى).
 *
 * ⚠️ هذا ليس قياس إنتاج: لا PostgreSQL ولا مزوّد AI حقيقي. الغرض إثبات أثر
 * التجميع/التوازي على الجدولة بشكل قابل للتكرار، لا ادّعاء سرعة إنتاجية.
 *
 * التشغيل:
 *   AI_JOB_CONCURRENCY=1 npx tsx tests/p16-benchmark-reply-queue.ts
 *   AI_JOB_CONCURRENCY=4 npx tsx tests/p16-benchmark-reply-queue.ts
 *   (أو npm run bench:queue بعد ضبط AI_JOB_CONCURRENCY)
 *
 * كل مهمة = محادثة مختلفة (أو نفس المحادثة بالترتيب) وتنام `PROVIDER_MS`
 * (افتراضي 120ms) لتمثيل زمن المزوّد. المخرجات: P50/P95 لزمن المهمة، وزمن
 * انتظار أول مهمة، والزمن الكلي، وعدد العينات.
 */
import { createFakeDb } from "./helpers/inmemory-db";
import { AI_JOB_CONCURRENCY, processPendingJobs } from "../src/modules/jobs/service";
import type { JobHandler } from "../src/modules/jobs/service";

const WS = "ws-bench";
const CONVERSATIONS = Number(process.env.BENCH_CONVERSATIONS ?? 8);
const PER_CONVERSATION = Number(process.env.BENCH_PER_CONVERSATION ?? 5);
const PROVIDER_MS = Number(process.env.BENCH_PROVIDER_MS ?? 120);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const db = createFakeDb();
  const total = CONVERSATIONS * PER_CONVERSATION;

  for (let c = 0; c < CONVERSATIONS; c++) {
    for (let i = 0; i < PER_CONVERSATION; i++) {
      await db.backgroundJob.create({
        data: {
          workspaceId: WS,
          type: "process_ai_message",
          payload: { conversationId: `conv-${c}`, messageId: `m-${c}-${i}` },
          runAfter: new Date(0),
          createdAt: new Date(1_000 + c * PER_CONVERSATION + i),
        },
      } as never);
    }
  }

  const startedAt = Date.now();
  const startDelayByJob = new Map<string, number>();
  const durationByJob = new Map<string, number>();

  const handler: JobHandler = async (payload, jobId) => {
    startDelayByJob.set(jobId, Date.now() - startedAt);
    await sleep(PROVIDER_MS);
    durationByJob.set(jobId, Date.now() - startedAt);
    void payload;
    return { success: true };
  };

  const result = await processPendingJobs(db as never, { process_ai_message: handler }, {
    limit: total,
    maintenance: false,
  });
  const wallMs = Date.now() - startedAt;

  const durations = [...durationByJob.values()];
  const starts = [...startDelayByJob.values()];

  console.log(
    JSON.stringify(
      {
        note: "local in-memory DB + simulated provider latency (NOT production)",
        aiJobConcurrency: AI_JOB_CONCURRENCY,
        conversations: CONVERSATIONS,
        perConversation: PER_CONVERSATION,
        samples: durations.length,
        processed: result.processed,
        failed: result.failed,
        providerDelayMs: PROVIDER_MS,
        wallMs,
        throughputJobsPerSec: Number((durations.length / (wallMs / 1000)).toFixed(2)),
        firstStartDelayMs: { p50: percentile(starts, 50), p95: percentile(starts, 95) },
        jobCompletionMs: { p50: percentile(durations, 50), p95: percentile(durations, 95) },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
