import {
  EMPTY_INTEL_FIELDS,
  emptyMeta,
  requiredProgress,
  type IntelFields,
  type IntelFieldMetaMap,
  type RequiredProgress,
} from "./fields";
import { enabledFieldDefs, getCollectionFields, type CollectionFieldSetting } from "./settings";

type AnyDb = Record<string, any>;

export interface LabPageDto {
  id: string;
  displayName: string;
  type: string;
  status: string;
}

export interface Percentiles {
  p50: number | null;
  p95: number | null;
  samples: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

function stats(values: number[]): Percentiles {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), samples: sorted.length };
}

export interface LabSnapshot {
  pages: LabPageDto[];
  stats: {
    collectionPages: number;
    conversations: number;
    customersWithIntel: number;
    pendingAnalysis: number;
    failedAnalysis: number;
    lastInboundAt: string | null;
  };
  /** قياسات حقيقية من سجل التحليل — مفصولة عن زمن المزوّد. */
  performance: {
    queueWaitMs: Percentiles;
    extractionMs: Percentiles;
    totalMs: Percentiles;
    failures24h: number;
    runs24h: number;
    stuckQueued: number;
  };
}

export async function getLabSnapshot(db: AnyDb, workspaceId: string): Promise<LabSnapshot> {
  const pages: LabPageDto[] = await db.channel.findMany({
    where: { workspaceId, sendMode: "COLLECTION_ONLY" },
    select: { id: true, displayName: true, type: true, status: true },
    orderBy: { displayName: "asc" },
  });
  const pageIds = pages.map((p) => p.id);
  const pageScope = { workspaceId, channelId: { in: pageIds } };
  if (pageIds.length === 0) {
    return {
      pages: [],
      stats: { collectionPages: 0, conversations: 0, customersWithIntel: 0, pendingAnalysis: 0, failedAnalysis: 0, lastInboundAt: null },
      performance: {
        queueWaitMs: stats([]),
        extractionMs: stats([]),
        totalMs: stats([]),
        failures24h: 0,
        runs24h: 0,
        stuckQueued: 0,
      },
    };
  }

  const [conversations, customersWithIntel, failedAnalysis, inboundCount, doneRuns, lastInbound] = await Promise.all([
    db.conversation.count({ where: { ...pageScope, deletedAt: null } }),
    db.customerIntel.count({ where: { ...pageScope, status: { in: ["READY", "NEEDS_REVIEW"] } } }),
    db.customerIntel.count({ where: { ...pageScope, status: "FAILED" } }),
    db.message.count({
      where: {
        workspaceId,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        conversation: { channelId: { in: pageIds }, deletedAt: null },
      },
    }),
    db.customerIntelRun.count({ where: { ...pageScope, status: "DONE" } }),
    db.message.findFirst({
      where: {
        workspaceId,
        direction: "INBOUND",
        conversation: { channelId: { in: pageIds }, deletedAt: null },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const since = new Date(Date.now() - 24 * 3600_000);
  const stuckBefore = new Date(Date.now() - 5 * 60_000);
  const [recentRuns, runs24h, failures24h, stuckQueued] = await Promise.all([
    db.customerIntelRun.findMany({
      where: { ...pageScope, status: "DONE" },
      orderBy: { queuedAt: "desc" },
      take: 200,
      select: { queuedAt: true, startedAt: true, finishedAt: true, latencyMs: true },
    }),
    db.customerIntelRun.count({ where: { ...pageScope, queuedAt: { gte: since } } }),
    db.customerIntelRun.count({ where: { ...pageScope, queuedAt: { gte: since }, status: "FAILED" } }),
    db.customerIntelRun.count({ where: { ...pageScope, status: "QUEUED", queuedAt: { lt: stuckBefore } } }),
  ]);

  const queueWait: number[] = [];
  const extraction: number[] = [];
  const total: number[] = [];
  for (const r of recentRuns as Array<Record<string, any>>) {
    const q = new Date(r.queuedAt).getTime();
    const s = r.startedAt ? new Date(r.startedAt).getTime() : null;
    const f = r.finishedAt ? new Date(r.finishedAt).getTime() : null;
    if (s !== null) queueWait.push(Math.max(0, s - q));
    if (typeof r.latencyMs === "number") extraction.push(r.latencyMs);
    if (f !== null) total.push(Math.max(0, f - q));
  }

  return {
    pages,
    stats: {
      collectionPages: pages.length,
      conversations,
      customersWithIntel,
      pendingAnalysis: Math.max(0, inboundCount - doneRuns),
      failedAnalysis,
      lastInboundAt: lastInbound?.createdAt ? new Date(lastInbound.createdAt).toISOString() : null,
    },
    performance: {
      queueWaitMs: stats(queueWait),
      extractionMs: stats(extraction),
      totalMs: stats(total),
      failures24h,
      runs24h,
      stuckQueued,
    },
  };
}

export interface LabConversationSummary {
  id: string;
  customer: { id: string; name: string | null };
  page: { id: string; displayName: string };
  lastInbound: { text: string | null; at: string | null };
  /** تقدّم البيانات المطلوب تجميعها (المفعّلة فقط). */
  progress: RequiredProgress;
  intel: {
    status: string;
    confidence: number;
    extractedAt: string | null;
    reviewedAt: string | null;
    lastError: string | null;
    highlights: string[];
  } | null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function highlightsOf(data: Record<string, unknown> | null | undefined): string[] {
  if (!data) return [];
  const out: string[] = [];
  const name = textOf(data.customerName);
  if (name) out.push(name);
  const phone = textOf(data.phone);
  if (phone) out.push(phone);
  const city = textOf(data.city);
  if (city) out.push(city);
  const address = textOf(data.address);
  if (address) out.push(address);
  const products = listOf(data.products);
  if (products.length) out.push(products.slice(0, 2).join(" · "));
  const order = textOf(data.order);
  if (order) out.push(order);
  if (typeof data.quantity === "number") out.push(`الكمية: ${data.quantity}`);
  const budget = textOf(data.budget);
  if (budget) out.push(budget);
  return out.slice(0, 5);
}

export async function listLabConversations(
  db: AnyDb,
  params: { workspaceId: string; channelId?: string; limit?: number }
): Promise<LabConversationSummary[]> {
  const channelFilter: Record<string, unknown> = { sendMode: "COLLECTION_ONLY" };
  if (params.channelId) channelFilter.id = params.channelId;
  const fieldDefs = enabledFieldDefs(await getCollectionFields(db, params.workspaceId));
  const rows = await db.conversation.findMany({
    where: { workspaceId: params.workspaceId, deletedAt: null, channel: channelFilter },
    orderBy: [{ lastCustomerMessageAt: "desc" }, { updatedAt: "desc" }],
    take: Math.min(Math.max(params.limit ?? 50, 1), 100),
    include: {
      customer: { select: { id: true, name: true } },
      channel: { select: { id: true, displayName: true } },
      messages: {
        where: { direction: "INBOUND" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { text: true, createdAt: true },
      },
      customerIntel: {
        select: { status: true, data: true, confidence: true, extractedAt: true, reviewedAt: true, lastError: true },
      },
    },
  });
  return (rows as Array<Record<string, any>>).map((c) => ({
    id: c.id,
    customer: { id: c.customer?.id ?? c.customerId, name: c.customer?.name ?? null },
    page: { id: c.channel?.id ?? c.channelId, displayName: c.channel?.displayName ?? "" },
    lastInbound: {
      text: c.messages?.[0]?.text ? String(c.messages[0].text).slice(0, 160) : null,
      at: c.messages?.[0]?.createdAt ? new Date(c.messages[0].createdAt).toISOString() : null,
    },
    progress: requiredProgress(c.customerIntel?.data as IntelFields | null, fieldDefs),
    intel: c.customerIntel
      ? {
          status: c.customerIntel.status,
          confidence: Number(c.customerIntel.confidence ?? 0),
          extractedAt: c.customerIntel.extractedAt ? new Date(c.customerIntel.extractedAt).toISOString() : null,
          reviewedAt: c.customerIntel.reviewedAt ? new Date(c.customerIntel.reviewedAt).toISOString() : null,
          lastError: c.customerIntel.lastError ?? null,
          highlights: highlightsOf(c.customerIntel.data as Partial<IntelFields>),
        }
      : null,
  }));
}

export async function getLabConversation(
  db: AnyDb,
  params: { workspaceId: string; conversationId: string }
): Promise<Record<string, unknown> | null> {
  const c = await db.conversation.findUnique({
    where: { id: params.conversationId },
    include: {
      customer: { select: { id: true, name: true } },
      channel: { select: { id: true, displayName: true, sendMode: true } },
      customerIntel: true,
      messages: {
        orderBy: { createdAt: "asc" },
        take: 300,
        select: {
          id: true,
          senderType: true,
          direction: true,
          type: true,
          text: true,
          mediaUrl: true,
          deliveryStatus: true,
          createdAt: true,
        },
      },
    },
  });
  if (!c || c.workspaceId !== params.workspaceId) return null;
  if (c.channel?.sendMode !== "COLLECTION_ONLY") return null;

  const fieldSettings: CollectionFieldSetting[] = await getCollectionFields(db, params.workspaceId);
  const activeDefs = enabledFieldDefs(fieldSettings);

  const intel = c.customerIntel
    ? {
        status: c.customerIntel.status,
        confidence: c.customerIntel.confidence,
        lastError: c.customerIntel.lastError,
        extractedAt: c.customerIntel.extractedAt,
        reviewedAt: c.customerIntel.reviewedAt,
        data: { ...EMPTY_INTEL_FIELDS, ...(c.customerIntel.data as IntelFields) },
        fields: { ...emptyMeta(activeDefs), ...(c.customerIntel.fieldMeta as IntelFieldMetaMap) },
      }
    : null;

  return {
    id: c.id,
    page: { id: c.channel.id, displayName: c.channel.displayName },
    customer: { id: c.customer?.id ?? c.customerId, name: c.customer?.name ?? null },
    fieldDefs: fieldSettings,
    progress: requiredProgress((intel?.data ?? null) as IntelFields | null, activeDefs),
    messages: (c.messages as Array<Record<string, any>>).map((m) => ({
      id: m.id,
      senderType: m.senderType,
      direction: m.direction,
      type: m.type,
      text: m.text,
      mediaUrl: m.mediaUrl ?? null,
      deliveryStatus: m.deliveryStatus ?? null,
      createdAt: m.createdAt,
    })),
    intel,
  };
}
