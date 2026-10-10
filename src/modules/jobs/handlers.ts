import { childLogger } from "@/core/logger";
import { processPendingJobs, type JobHandler } from "@/modules/jobs/service";
import { handleChannelInbound } from "@/modules/channels/inbound-job";
import { getEmbeddingProvider, getCurrentEmbeddingIdentity } from "@/modules/knowledge/embeddings";
import { classifySentiment } from "@/modules/feedback/service";

const log = childLogger("jobs");

/**
 * P7 — Workflow job handlers:
 * - run_workflow_event: evaluate published workflows for one trusted event
 *   (idempotent via AutomationExecution unique (automationId, triggerEventId)).
 * - resume_workflow_executions: WAITING runs past their resumeAt get one
 *   re-enqueued (deterministic key) — durable timers without in-memory state.
 */
async function handleRunWorkflowEvent(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const { evaluateWorkflowEvent } = await import("@/modules/automation/workflow-engine");
  const result = await evaluateWorkflowEvent(db as never, {
    name: String(payload.eventName ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    payload: (payload.payload as Record<string, unknown>) ?? {},
    eventId: String(payload.eventId ?? ""),
  });
  void result;
  return { success: true };
}

const WF_RESUME_JOB_MAX = 100;

async function handleResumeWorkflowExecutions(db: HandlerDb): Promise<{ success: boolean; error?: string }> {
  const due = await (db as never as {
    automationExecution: {
      findMany: (a: unknown) => Promise<Array<Record<string, unknown>>>;
      findUnique: (a: unknown) => Promise<Record<string, unknown> | null>;
      update: (a: unknown) => Promise<unknown>;
    };
    automation: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> };
    automationVersion: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> };
  }).automationExecution.findMany({
    where: { status: "WAITING" },
    take: WF_RESUME_JOB_MAX,
    orderBy: { startedAt: "asc" },
    select: { id: true, automationId: true, triggerEventId: true, workspaceId: true, metadata: true },
  });
  const now = Date.now();
  let resumed = 0;
  for (const ex of due) {
    const at = (ex.metadata as { resumeAt?: string } | null)?.resumeAt;
    if (!at || new Date(at).getTime() > now) continue;
    // Re-enqueue with the DETERMINISTIC trigger key — the evaluation re-runs
    // idempotently and resumes the frozen snapshot at its cursor.
    const wf = await (db as never as { automation: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> } }).automation.findUnique({ where: { id: String(ex.automationId) } });
    if (!wf || wf.status !== "PUBLISHED" || wf.isEnabled !== true) {
      // Unpublished/paused mid-WAIT → cancel safely (no further steps).
      await (db as never as { automationExecution: { update: (a: unknown) => Promise<unknown> } }).automationExecution.update({
        where: { id: String(ex.id) },
        data: { status: "CANCELLED", error: "WORKFLOW_CANCELLED:UNPUBLISHED_DURING_WAIT", errorCategory: "CANCELLED", completedAt: new Date() },
      });
      continue;
    }
    const { enqueueJob } = await import("@/modules/jobs/service");
    const res = await enqueueJob(db as never, {
      workspaceId: String(ex.workspaceId),
      type: "run_workflow_event",
      payload: {
        eventName: "WorkflowResumed",
        workspaceId: ex.workspaceId,
        eventId: String(ex.triggerEventId),
        payload: { resumeExecutionId: ex.id },
      },
      idempotencyKey: `wf-resume:${ex.id}:${ex.stepIndex}`,
    }).catch(() => null);
    if (res && !res.deduplicated) resumed += 1;
  }
  if (resumed > 0) log.info({ resumed }, "workflow_resumes_enqueued");
  return { success: true };
}

type HandlerDb = Parameters<typeof processPendingJobs>[0];

/**
 * process_knowledge_document: chunk → embed → persist active vectors.
 * Idempotent: deactivates existing chunks first; safe to retry.
 * Records embedding provider/model/dimensions for version tracking.
 */
async function handleProcessDocument(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const documentId = String(payload.documentId ?? "");
  const doc = await db.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!doc) return { success: false, error: "Document not found" };

  try {
    const { chunkText } = await import("@/modules/knowledge/chunker");
    const provider = getEmbeddingProvider();
    const { provider: providerName, model, dimensions } = getCurrentEmbeddingIdentity();

    const chunks = chunkText(doc.content, {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      category: doc.category,
      documentVersion: doc.version,
    });
    if (chunks.length === 0) throw new Error("Document produced no chunks");

    await db.knowledgeChunk.updateMany({ where: { documentId: doc.id }, data: { isActive: false } });

    for (const chunk of chunks) {
      const embedding = await provider.embed(chunk.content);
      await db.knowledgeChunk.create({
        data: {
          documentId: doc.id,
          workspaceId: doc.workspaceId,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          tokenCount: chunk.tokenCount,
          metadata: {
            category: doc.category,
            documentVersion: doc.version,
            ...chunk.metadata,
          },
          embedding: `[${embedding.join(",")}]`,
          isActive: true,
          embeddingProvider: providerName,
          embeddingModel: model,
          embeddingDimensions: dimensions,
        } as never,
      });
    }

    await db.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "READY", error: null },
    });
    log.info({ documentId: doc.id, chunks: chunks.length }, "document_processed");
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "FAILED", error: message },
    });
    return { success: false, error: message };
  }
}

/** analyze_feedback: rule-based sentiment for feedback rows missing one. */
async function handleAnalyzeFeedback(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const feedbackId = String(payload.feedbackId ?? "");
  const feedback = await db.feedback.findUnique({ where: { id: feedbackId } });
  if (!feedback) return { success: false, error: "Feedback not found" };
  if (!feedback.content) {
    await db.feedback.update({ where: { id: feedback.id }, data: { sentiment: "neutral" } });
    return { success: true };
  }
  await db.feedback.update({
    where: { id: feedback.id },
    data: { sentiment: classifySentiment(feedback.content) },
  });
  return { success: true };
}

/** process_media: extracts image dimensions for common formats (no vision AI). */
async function handleProcessMedia(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const mediaId = String(payload.mediaId ?? "");
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset) return { success: false, error: "Media asset not found" };

  const metadata: Record<string, unknown> = { ...(asset.metadata as Record<string, unknown>) };
  if (asset.mimeType === "image/png") {
    // PNG: width/height live at fixed offsets in IHDR.
    try {
      const { getStorage } = await import("@/modules/media/storage");
      const file = await getStorage().get(asset.storageKey);
      if (file) {
        const chunks: Buffer[] = [];
        for await (const c of file.stream) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
          await db.mediaAsset.update({
            where: { id: asset.id },
            data: { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) },
          });
        }
      }
    } catch {
      // dimension extraction is best-effort; never fails the job
    }
  }
  metadata.processedAt = new Date().toISOString();
  await db.mediaAsset.update({ where: { id: asset.id }, data: { metadata: metadata as never } });
  return { success: true };
}

/** process_ai_message: runs the AI orchestrator for one inbound message. */
async function handleProcessAIMessage(db: HandlerDb, payload: Record<string, unknown>, workspaceId: string): Promise<{ success: boolean; error?: string }> {
  // Fail loudly instead of silently no-oping: an empty workspace context made
  // gating return SKIPPED, the job complete DONE, and the orphan sweeper
  // re-enqueue the same message forever (silent hot loop with zero logs).
  if (!workspaceId) {
    return { success: false, error: "MISSING_WORKSPACE_CONTEXT" };
  }
  const { processAIMessage } = await import("@/modules/ai/orchestrator");
  const vectorStore = await buildWorkspaceVectorStore(db, workspaceId);
  const result = await processAIMessage(db, {
    workspaceId,
    conversationId: String(payload.conversationId ?? ""),
    messageId: String(payload.messageId ?? ""),
  }, { vectorStore });
  // Transient AI provider failures are retried by the job queue; permanent
  // gates (AI disabled, duplicate, takeover) are terminal successes.
  if (result.status === "AI_FAILED") {
    return { success: false, error: result.error ?? "AI failed" };
  }
  return { success: true };
}

/**
 * Builds an in-memory vector store from this workspace's active chunks.
 * Cached per workspace for 60s so a burst of AI jobs doesn't rescan up to
 * 1000 chunks + JSON.parse embeddings on EVERY message (latency fix).
 * Read-only snapshot semantics: a 60s delay in seeing new docs is acceptable.
 */
const vectorStoreCache = new Map<string, { at: number; store: Awaited<ReturnType<typeof buildWorkspaceVectorStoreUncached>> }>();
const VECTOR_STORE_CACHE_MS = 60_000;

async function buildWorkspaceVectorStore(db: HandlerDb, workspaceId: string) {
  const cached = vectorStoreCache.get(workspaceId);
  if (cached && Date.now() - cached.at < VECTOR_STORE_CACHE_MS) return cached.store;
  const store = await buildWorkspaceVectorStoreUncached(db, workspaceId);
  vectorStoreCache.set(workspaceId, { at: Date.now(), store });
  // Bound cache to avoid unbounded workspace growth in long-lived workers.
  if (vectorStoreCache.size > 200) {
    const oldest = [...vectorStoreCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) vectorStoreCache.delete(oldest);
  }
  return store;
}

async function buildWorkspaceVectorStoreUncached(db: HandlerDb, workspaceId: string) {
  const { InMemoryVectorStore } = await import("@/modules/knowledge/vector-store");
  const { getCurrentEmbeddingIdentity } = await import("@/modules/knowledge/embeddings");
  const filter = getCurrentEmbeddingIdentity();
  const chunks = await (db as any).knowledgeChunk.findMany({
    where: {
      workspaceId,
      isActive: true,
      embeddingProvider: filter.provider,
      embeddingModel: filter.model,
      embeddingDimensions: filter.dimensions,
    },
    take: 1000,
  });
  const vectors = new Map<string, number[]>();
  const rows = new Map<string, { documentId: string; workspaceId: string; content: string; metadata: Record<string, unknown>; isActive: boolean; embeddingProvider?: string; embeddingModel?: string; embeddingDimensions?: number }>();
  for (const c of chunks) {
    if (!c.embedding) continue;
    vectors.set(c.id, typeof c.embedding === "string" ? JSON.parse(c.embedding) : c.embedding);
    rows.set(c.id, {
      documentId: c.documentId,
      workspaceId,
      content: c.content,
      metadata: c.metadata,
      isActive: true,
      embeddingProvider: c.embeddingProvider,
      embeddingModel: c.embeddingModel,
      embeddingDimensions: c.embeddingDimensions,
    });
  }
  return new InMemoryVectorStore(vectors, rows);
}

/** generate_summary: refreshes conversation.summary via the SUMMARY model. */
async function handleGenerateSummary(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const conversationId = String(payload.conversationId ?? "");
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return { success: false, error: "Conversation not found" };

  const messages = await db.message.findMany({
    where: { conversationId, deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { direction: true, senderType: true, text: true },
  });

  const { getAIProvider } = await import("@/modules/ai/provider");
  const { resolveModel, loadAISettings, withRetry, logUsage } = await import("@/modules/ai/router");
  const { coreSystemRules, wrapUntrustedCustomerContent, summaryInstruction, PROMPT_VERSIONS } = await import("@/modules/ai/prompts");
  const { summaryResultSchema, validateStructured } = await import("@/modules/ai/structured");
  const { heuristicIntent } = await import("@/modules/ai/intent");

  const settings = (await loadAISettings(db, conversation.workspaceId)) as never;
  const cfg = resolveModel(settings, "SUMMARY");
  const provider = getAIProvider();
  const transcript = messages
    .reverse()
    .map((m) => `${m.direction === "INBOUND" ? "العميل" : "المتجر"}: ${m.text ?? "[وسائط]"}`)
    .join("\n");

  // P1 privacy gate: the transcript carries raw customer turns — the
  // external SUMMARY model receives tokens only; the stored summary is
  // restored locally (internal DB content, never re-sent).
  const { sendProtectedStructured } = await import("@/modules/ai/privacy-gate");
  const summaryCustomer = (await db.customer.findUnique({
    where: { id: conversation.customerId },
    select: { name: true, phone: true, email: true, address: true },
  }).catch(() => null)) as { name?: string | null; phone?: string | null; email?: string | null; address?: string | null } | null;

  try {
    const res = await withRetry(() =>
      sendProtectedStructured(provider, {
        system: `${coreSystemRules()}\n\n${summaryInstruction()}`,
        user: wrapUntrustedCustomerContent(transcript, []),
        model: cfg.model,
        temperature: 0.2,
        maxTokens: cfg.maxTokens,
        validate: (raw) => validateStructured(summaryResultSchema, raw),
      }, { pii: summaryCustomer ?? {}, purpose: "SUMMARY" })
    );
    await db.conversation.update({ where: { id: conversationId }, data: { summary: res.value.summary } });
    await logUsage(db, {
      workspaceId: conversation.workspaceId,
      conversationId,
      purpose: "SUMMARY",
      provider: provider.name,
      model: cfg.model,
      promptVersion: PROMPT_VERSIONS.SUMMARY,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      latencyMs: res.latencyMs,
      success: true,
    });
    return { success: true };
  } catch (err) {
    // Deterministic fallback summary — never blocks the pipeline.
    const fallbackIntent = heuristicIntent(transcript.slice(-300));
    await db.conversation.update({
      where: { id: conversationId },
      data: { summary: `آخر نشاط: ${messages.length} رسالة. آخر نية مرصودة: ${fallbackIntent.intent}.` },
    });
    void err;
    return { success: true };
  }
}

/** process_webhook_event: normalized Facebook events → Conversation Engine. */
export async function handleProcessWebhookEvent(db: HandlerDb, payload: Record<string, unknown>, _jobId?: string): Promise<{ success: boolean; error?: string }> {
  const started = Date.now();
  const { processIncomingMessage } = await import("@/modules/conversations/service");
  const workspaceId = String(payload.workspaceId ?? "");
  const webhookEventId = String(payload.webhookEventId ?? "");
  const channelAccountId = String(payload.channelAccountId ?? "");
  const messages = (payload.messages as Array<Record<string, unknown>>) ?? [];

  // Resolve the exact channel (page) once per batch for correct token + badge.
  let channelId: string | undefined;
  let pageToken: string | null = null;
  try {
    const account = await (db as any).channelAccount.findUnique({
      where: { id: channelAccountId },
      include: { channel: true },
    });
    channelId = account?.channel?.id ?? account?.channelId;
    if (account?.encryptedCredentials) {
      const { decryptSecret } = await import("@/core/crypto");
      try {
        pageToken = decryptSecret(account.encryptedCredentials);
      } catch {
        pageToken = null;
      }
    }
  } catch {
    channelId = undefined;
  }

  const { getFacebookClient } = await import("@/modules/channels/facebook/client");
  const { resolveSenderName } = await import("@/modules/channels/facebook/profile");
  const fbClient = getFacebookClient();
  // Profile lookups for the whole batch run concurrently (each is throttled +
  // cached inside resolveSenderName), so a 10-message batch doesn't pay
  // N×4s sequential Graph timeouts before the first message is ingested.
  const profileResults = await Promise.all(
    messages.map(async (m) => {
      const psid = String(m.externalCustomerId ?? "");
      try {
        const resolved = await resolveSenderName(db, { workspaceId, psid, pageToken, client: fbClient });
        return { psid, name: resolved.name, avatar: resolved.avatarUrl };
      } catch {
        return { psid, name: null, avatar: null };
      }
    })
  );
  const profileByPsid = new Map(profileResults.map((r) => [r.psid, r]));
  let processed = 0;
  let failed = 0;
  for (const m of messages) {
    const psid = String(m.externalCustomerId ?? "");
    // Best-effort sender profile (throttled, cached): fills Customer.name /
    // avatarUrl so the inbox shows real identity instead of fallbacks.
    // Never blocks ingestion on failure — falls through to nulls.
    const prof = profileByPsid.get(psid);
    const senderName: string | null = prof?.name ?? null;
    const senderAvatar: string | null = prof?.avatar ?? null;
    try {
      await processIncomingMessage(db, {
        workspaceId,
        channelType: "FACEBOOK",
        channelId,
        externalUserId: psid,
        externalUserName: (m.externalUserName as string | undefined) ?? senderName ?? undefined,
        externalAvatarUrl: (m.externalAvatarUrl as string | undefined) ?? senderAvatar ?? undefined,
        externalConversationId: String(m.externalConversationId ?? ""),
        externalMessageId: String(m.externalMessageId ?? ""),
        externalEventId: String(m.externalEventId ?? ""),
        provider: "facebook",
        type: "TEXT",
        text: (m.text as string) ?? null,
        metadata: { channelAccountId: m.channelAccountId, attachments: m.attachments ?? [] },
        sentAt: m.timestamp ? new Date(m.timestamp as string) : undefined,
      });
      processed += 1;
    } catch (err) {
      // One poison message must not drop the whole batch — each message is
      // independently idempotent and retried via its own job/redelivery.
      failed += 1;
      log.warn(
        { webhookEventId, workspaceId, error: err instanceof Error ? err.message : String(err) },
        "webhook_message_failed"
      );
    }
  }

  try {
    await (db as any).webhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date() },
    });
  } catch {
    // never fail the batch on bookkeeping
  }
  log.info(
    { webhookEventId, workspaceId, processed, failed, durationMs: Date.now() - started },
    "webhook_event_processed"
  );
  // ANY poisoned message fails the batch: successes are idempotent (redelivery
  // returns duplicate:true without new jobs), so retrying is safe — while a
  // partial success would silently abandon the failed messages forever.
  return failed > 0
    ? { success: false, error: `${failed} message(s) failed` }
    : { success: true };
}

/** evaluate_automation: runs the Automation Engine for one trusted event. */
async function handleEvaluateAutomation(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const { evaluateEvent } = await import("@/modules/automation/engine");
  const result = await evaluateEvent(db, {
    name: String(payload.eventName ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    eventId: String(payload.eventId ?? ""),
    payload: (payload.payload as Record<string, unknown>) ?? {},
    depth: Number(payload.depth ?? 0),
  });
  void result;
  return { success: true };
}

/** process_due_followups: scheduler entry — claim + execute due follow-ups. */
async function handleProcessDueFollowUps(db: HandlerDb): Promise<{ success: boolean; error?: string }> {
  const { processDueFollowUps } = await import("@/modules/automation/followup-service");
  await processDueFollowUps(db, 10);
  return { success: true };
}

/** aggregate_workspace_analytics: idempotent daily rebuild (supports late events). */
async function handleAggregateAnalytics(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const { rebuildRange } = await import("@/modules/analytics/aggregation");
  const workspaceId = String(payload.workspaceId ?? "");
  const from = payload.from ? new Date(String(payload.from)) : new Date(Date.now() - 2 * 24 * 3600_000);
  const to = payload.to ? new Date(String(payload.to)) : new Date();
  await rebuildRange(db, workspaceId, from, to);
  return { success: true };
}

/** run_campaign: P9 — بوابة البدء + لقطة المستلمين (durable, idempotent). */
async function handleRunCampaign(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const { startCampaignRun } = await import("@/modules/campaigns/campaign-runner");
  const result = await startCampaignRun(db as never, String(payload.campaignId ?? ""));
  return { success: true, ...(result.started ? {} : { error: result.reason }) };
}

/** campaign_tick: P9 — دفعة bounded مع إيقاف/إلغاء فوري وحد معدل durable. */
async function handleCampaignTick(db: HandlerDb, payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const { campaignTick } = await import("@/modules/campaigns/campaign-runner");
  await campaignTick(db as never, String(payload.campaignId ?? ""), Number(payload.seq ?? 1));
  return { success: true };
}

export function getJobHandlers(): Record<string, JobHandler> {
  return {
    process_knowledge_document: (payload) => handleProcessDocument(getDb(), payload),
    analyze_feedback: (payload) => handleAnalyzeFeedback(getDb(), payload),
    process_media: (payload) => handleProcessMedia(getDb(), payload),
    process_ai_message: (payload, jobId, workspaceId) =>
      handleProcessAIMessage(getDb(), payload, workspaceId || currentWorkspaceId(jobId)),
    generate_summary: (payload) => handleGenerateSummary(getDb(), payload),
    process_webhook_event: (payload, jobId) => handleProcessWebhookEvent(getDb(), payload),
    process_channel_inbound: (payload) => handleChannelInbound(getDb(), payload),
    evaluate_automation: (payload) => handleEvaluateAutomation(getDb(), payload),
    process_due_followups: () => handleProcessDueFollowUps(getDb()),
    aggregate_workspace_analytics: (payload) => handleAggregateAnalytics(getDb(), payload),
    run_workflow_event: (payload) => handleRunWorkflowEvent(getDb(), payload),
    resume_workflow_executions: () => handleResumeWorkflowExecutions(getDb()),
    run_campaign: (payload) => handleRunCampaign(getDb(), payload),
    campaign_tick: (payload) => handleCampaignTick(getDb(), payload),
  };
}

// The handlers receive the Prisma transaction client from the runner at call
// time; we keep a module-level reference set by runJobs().
let currentDb: HandlerDb | null = null;
const jobWorkspaces = new Map<string, string>();

function currentWorkspaceId(jobId: string): string {
  return jobWorkspaces.get(jobId) ?? "";
}

function getDb(): HandlerDb {
  if (!currentDb) throw new Error("Job runner DB not initialized");
  return currentDb;
}

export async function runJobs(db: HandlerDb, opts?: { limit?: number; workerId?: string }) {
  currentDb = db;
  // Track each job's workspace so handlers can scope tenant-isolated work.
  const pending = await (db as any).backgroundJob.findMany({
    where: { status: "PENDING", runAfter: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: opts?.limit ?? 10,
    select: { id: true, workspaceId: true },
  });
  jobWorkspaces.clear();
  for (const j of pending) jobWorkspaces.set(j.id, j.workspaceId);
  try {
    return await processPendingJobs(db, getJobHandlers(), opts);
  } finally {
    currentDb = null;
  }
}
