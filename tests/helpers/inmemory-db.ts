/**
 * Minimal in-memory Prisma stub covering the operations used by the
 * customers/conversations services, so the Phase-2 pipeline logic can be
 * unit-tested without a database.
 */
type Row = Record<string, any>;

function matchesCondition(value: any, cond: any): boolean {
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond === null || cond === undefined) return (value ?? null) === cond;
  if (typeof cond !== "object" || Array.isArray(cond) || cond instanceof Date) {
    return value === cond;
  }
  // Prisma semantics: multiple operators on one field are ANDed (e.g. gte+lt ranges).
  let result = true;
  for (const [op, arg] of Object.entries(cond)) {
    if (op === "mode") continue; // modifier for contains, not an operator
    if (op === "not") { result = result && (value ?? null) !== (arg ?? null); continue; }
    if (op === "contains") {
      const hay = String(value ?? "");
      const needle = String(arg);
      result = result && (cond.mode === "insensitive" ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle));
      continue;
    }
    if (op === "gt") { result = result && value > arg; continue; }
    if (op === "gte") { result = result && value >= arg; continue; }
    if (op === "lt") { result = result && value < arg; continue; }
    if (op === "lte") { result = result && value <= arg; continue; }
    if (op === "equals") { result = result && value === arg; continue; }
    if (op === "startsWith") { result = result && typeof value === "string" && value.startsWith(String(arg)); continue; }
    if (op === "in") { result = result && arg.includes(value); continue; }
    if (op === "notIn") { result = result && !arg.includes(value); continue; }
    if (op === "hasSome") { result = result && (Array.isArray(value) ? value : []).some((v) => arg.includes(v)); continue; }
    if (op === "hasEvery") { result = result && (Array.isArray(value) ? value : []).every((v) => arg.includes(v)); continue; }
  }
  return result;
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as Row[]).every((c) => matchesWhere(row, c))) return false;
    } else if (key === "OR") {
      if (!(cond as Row[]).some((c) => matchesWhere(row, c))) return false;
    } else if (key === "NOT") {
      if (matchesWhere(row, cond as Row)) return false;
    } else if (key.includes("_") && cond && typeof cond === "object") {
      // Compound unique key, e.g. workspaceId_channelConversationId
      const parts = key.split("_");
      for (let i = 0; i < parts.length; i++) {
        const expected = (cond as Row)[parts[i]];
        const actual = row[parts[i]];
        const equal = expected instanceof Date && actual instanceof Date
          ? actual.getTime() === expected.getTime()
          : actual === expected;
        if (!equal) return false;
      }
    } else if (cond && typeof cond === "object" && !Array.isArray(cond) && ("hasSome" in cond || "hasEvery" in cond)) {
      const arr: any[] = Array.isArray(row[key]) ? row[key] : [];
      if ("hasSome" in cond && !arr.some((v) => (cond as Row).hasSome.includes(v))) return false;
      if ("hasEvery" in cond && !arr.every((v) => (cond as Row).hasEvery.includes(v))) return false;
    } else if (cond && typeof cond === "object" && ("some" in (cond as Row) || "none" in (cond as Row))) {
      const related: Row[] = row[key] ?? [];
      if ("some" in (cond as Row) && !related.some((r) => matchesWhere(r, (cond as Row).some))) return false;
      if ("none" in (cond as Row) && related.some((r) => matchesWhere(r, (cond as Row).none))) return false;
    } else if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      const ops = new Set(["contains", "not", "in", "notIn", "gt", "gte", "lt", "lte", "equals", "mode", "startsWith"]);
      if (Object.keys(cond as Row).every((k) => ops.has(k))) {
        if (!matchesCondition(row[key], cond)) return false;
      } else {
        // Nested relation filter (e.g. channel: { type: {...} })
        let matched = true;
        const base = row[key];
        for (const [sub, subCond] of Object.entries(cond as Row)) {
          if (sub === "some") {
            const related: Row[] = row[key] ?? [];
            if (!related.some((r) => matchesWhere(r, subCond as Row))) matched = false;
          } else if (base && typeof base === "object" && !Array.isArray(base)) {
            if (!matchesWhere(base, { [sub]: subCond })) matched = false;
          } else if (!matchesCondition(row[sub], subCond)) {
            matched = false;
          }
        }
        if (!matched) return false;
      }
    } else if (!matchesCondition(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(row: Row, data: Row): Row {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) {
      row[k] = (row[k] ?? 0) + v.increment;
    } else if (v !== undefined) {
      row[k] = v;
    }
  }
  return row;
}

function sortRows(rows: Row[], orderBy: Row[] | Row | undefined): Row[] {
  if (!orderBy) return rows;
  const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const av = val(a[field]);
        const bv = val(b[field]);
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return dir === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

const cloneRow = (r: Row): Row => JSON.parse(JSON.stringify(r));

// Relation attachment for where-filter evaluation (Prisma relation filters).
let allStores: Record<string, Row[]> | null = null;
const RELATIONS: Record<string, Record<string, string>> = {
  customer: { orders: "order", conversations: "conversation", attributionTouches: "attributionTouch" },
  conversation: { channel: "channel" },
};
// العلاقات الي ربطناها نحنا (مش الي جاية من بيانات الاختبار) بتنقرأ من جديد
// بكل استعلام — وإلا طلب انضاف بعد أول استعلام ما بيبين بفلاتر العلاقات.
const attachedByUs = new WeakMap<Row, Set<string>>();
function attachRelations(name: string, row: Row) {
  const rel = RELATIONS[name];
  if (!rel || !allStores) return;
  for (const key of Object.keys(rel)) {
    const ours = attachedByUs.get(row);
    if (row[key] !== undefined && !ours?.has(key)) continue;
    if (ours) ours.add(key);
    else attachedByUs.set(row, new Set([key]));
    if (key === "channel") {
      row[key] = (allStores.channel ?? []).find((c: Row) => c.id === row.channelId) ?? null;
    } else {
      row[key] = (allStores[rel[key]] ?? []).filter((r: Row) => r.customerId === row.id);
    }
  }
}

function simulateInclude(row: Row, args: any): Row {
  const out = cloneRow(row);
  const inc = args?.include ?? args?.with;
  if (inc && typeof inc === "object") {
    for (const key of Object.keys(inc)) {
      if (out[key] === undefined) {
        out[key] = inc[key] && typeof inc[key] === "object" && "select" in inc[key] ? {} : [];
      }
    }
  }
  return out;
}

function makeModel(name: string, store: Row[], defaults: Row = {}) {
  return {
    async findUnique(args: any) {
      const where = args.where ?? {};
      if (Object.keys(where).length === 1 && where.id !== undefined) {
        const row = store.find((r) => r.id === where.id);
        return row ? simulateInclude(row, args) : null;
      }
      const row = store.find((r) => matchesWhere(r, where));
      return row ? (store.forEach((r) => attachRelations(name, r)), simulateInclude(row, args)) : null;
    },
    async findFirst(args: any) {
      store.forEach((r) => attachRelations(name, r));
      // Prisma semantics: findFirst honors orderBy (e.g. "latest episode start",
      // "last alert"). Without orderBy the first match in insertion order (unchanged).
      const row = args?.orderBy
        ? sortRows(store.filter((r) => matchesWhere(r, args.where)), args.orderBy)[0]
        : store.find((r) => matchesWhere(r, args.where));
      return row ? simulateInclude(row, args) : null;
    },
    async findUniqueOrThrow(args: any) {
      const row = await (this as any).findUnique(args);
      if (!row) throw new Error(`${name}: record not found`);
      return row;
    },
    async findMany(args: any = {}) {
      store.forEach((r) => attachRelations(name, r));
      let rows = store.filter((r) => matchesWhere(r, args.where));
      rows = sortRows(rows, args.orderBy);
      if (args.cursor?.id) {
        const idx = rows.findIndex((r) => r.id === args.cursor.id);
        if (idx >= 0) rows = rows.slice(idx + (args.skip ?? 0) + (args.skip ? 0 : 0));
      }
      return rows.slice(0, args.take ?? Infinity).map((r) => simulateInclude(r, args));
    },
    async create(args: any) {
      const row: Row = {
        id: `c-${name}-${store.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...defaults,
        ...args.data,
      };
      // Enforce unique constraints the real DB enforces (subset used by tests):
      // automationId_triggerEventId / automationId_version / personaId_version /
      // customerId_type_key / idempotencyKey / workspaceId+phone.
      // NOTE: backgroundJob is handled by its own PARTIAL unique simulation
      // below (active-only) — do NOT add it here as a global unique.
      const uniqMap: Record<string, (r: Row, w: Row) => boolean> = {
        automationExecution: (r, w) => r.automationId === w.automationId && r.triggerEventId === w.triggerEventId,
        automationVersion: (r, w) => r.automationId === w.automationId && r.version === w.version,
        personaVersion: (r, w) => r.personaId === w.personaId && r.version === w.version,
        customerMemory: (r, w) => r.customerId === w.customerId && r.type === w.type && r.key === w.key,
        followUp: (r, w) => r.idempotencyKey !== undefined && r.idempotencyKey === w.idempotencyKey,
        // Postgres unique semantics: multiple NULLs are distinct.
        customer: (r, w) => w.phone != null && r.workspaceId === w.workspaceId && r.phone === w.phone,
        campaignContentVersion: (r, w) => r.campaignId === w.campaignId && r.version === w.version,
        campaignRecipient: (r, w) => r.campaignId === w.campaignId && r.customerId === w.customerId,
        // P12 — قيود الربط مع المنظومة (مطابقة لترحيل p12_ecosystem_integrations).
        attributionTouch: (r, w) => r.dedupeKey === w.dedupeKey,
        integrationConnection: (r, w) => r.workspaceId === w.workspaceId && r.system === w.system,
        integrationToken: (r, w) => r.tokenHash === w.tokenHash,
        integrationDelivery: (r, w) => r.dedupeKey === w.dedupeKey,
        agentDraft: (r, w) => w.idempotencyKey != null && r.workspaceId === w.workspaceId && r.idempotencyKey === w.idempotencyKey,
        productCompliance: (r, w) => r.productId === w.productId,
        omsConnection: (r, w) => r.workspaceId === w.workspaceId || (w.webhookKey != null && r.webhookKey === w.webhookKey),
        campaign: (r, w) => w.externalIdempotencyKey != null && r.workspaceId === w.workspaceId && r.externalIdempotencyKey === w.externalIdempotencyKey,
      };
      const uniq = uniqMap[name];
      if (uniq) {
        const dup = store.find((r) => uniq(r, args.data ?? {}));
        if (dup) {
          const err = new Error(`Unique constraint failed on ${name}`) as Error & { code?: string };
          err.code = "P2002";
          throw err;
        }
      }
      // simulate nested create (e.g. customer.create with identities.create)
      for (const [k, v] of Object.entries(row)) {
        if (v && typeof v === "object" && "create" in (v as Row)) {
          const nested: Row = {
            id: `n-${name}-${k}-${store.length}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...(v as Row).create,
          };
          nested[k === "identities" ? "customerId" : "parentId"] = row.id;
          row[k] = [nested];
        }
      }
      store.push(row);
      return simulateInclude(row, args);
    },
    async update(args: any) {
      const row = args.where.id !== undefined
        ? store.find((r) => r.id === args.where.id)
        : store.find((r) => matchesWhere(r, args.where));
      if (!row) throw new Error(`${name}: record not found`);
      applyUpdate(row, args.data);
      row.updatedAt = new Date();
      return simulateInclude(row, args);
    },
    async updateMany(args: any) {
      const rows = store.filter((r) => matchesWhere(r, args.where));
      for (const row of rows) {
        applyUpdate(row, args.data);
        row.updatedAt = new Date();
      }
      return { count: rows.length };
    },
    async deleteMany(args: any = {}) {
      let count = 0;
      for (let i = store.length - 1; i >= 0; i--) {
        if (matchesWhere(store[i], args.where)) {
          store.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
    async delete(args: any) {
      const idx = store.findIndex((r) => r.id === args.where.id);
      if (idx < 0) throw new Error(`${name}: record not found`);
      const [row] = store.splice(idx, 1);
      return simulateInclude(row, args);
    },
    async count(args: any = {}) {
      return store.filter((r) => matchesWhere(r, args.where)).length;
    },
    async upsert(args: any) {
      const where = args.where ?? {};
      // compound or id lookup
      let existing: Row | undefined;
      if (where.id !== undefined) existing = store.find((r) => r.id === where.id);
      else existing = store.find((r) => matchesWhere(r, where));
      if (existing) {
        applyUpdate(existing, args.update);
        existing.updatedAt = new Date();
        return simulateInclude(existing, args);
      }
      return this.create({ data: { ...args.create } });
    },
    async groupBy(args: any) {
      const rows = store.filter((r) => matchesWhere(r, args.where));
      const key = args.by[0] ?? args.by;
      const groups = new Map<unknown, Row>();
      for (const r of rows) {
        const k = r[key];
        const g = groups.get(k) ?? { [key]: k, _count: { [key]: 0 } };
        g._count[key] += 1;
        groups.set(k, g);
      }
      return [...groups.values()];
    },
    async createMany(args: any) {
      const data = Array.isArray(args.data) ? args.data : [args.data];
      const uniqMap: Record<string, (r: Row, w: Row) => boolean> = {
        campaignContentVersion: (r, w) => r.campaignId === w.campaignId && r.version === w.version,
        campaignRecipient: (r, w) => r.campaignId === w.campaignId && r.customerId === w.customerId,
      };
      const uniq = uniqMap[name];
      let count = 0;
      for (const d of data) {
        if (uniq && args.skipDuplicates) {
          const dup = store.find((r) => uniq(r, d as Row));
          if (dup) continue;
        }
        store.push({
          id: `c-${name}-${store.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...defaults,
          ...d,
        });
        count += 1;
      }
      return { count };
    },
  };
}

export function createFakeDb() {
  const customer: Row[] = [];
  const conversation: Row[] = [];
  const message: Row[] = [];
  const channelIdentity: Row[] = [];
  const channel: Row[] = [];
  const workspaceMember: Row[] = [];
  const auditLog: Row[] = [];
  const product: Row[] = [];
  const productVariant: Row[] = [];
  const productMedia: Row[] = [];
  const mediaAsset: Row[] = [];
  const feedback: Row[] = [];
  const knowledgeDocument: Row[] = [];
  const knowledgeChunk: Row[] = [];
  const faq: Row[] = [];
  const backgroundJob: Row[] = [];
  const aISettings: Row[] = [];
  const persona: Row[] = [];
  const personaVersion: Row[] = [];
  const customerMemory: Row[] = [];
  const knowledgeCitation: Row[] = [];
  const channelAccountRows: Row[] = [];
  const webhookEventRows: Row[] = [];
  const aIUsageLog: Row[] = [];
  const orderRows: Row[] = [];
  const orderItemRows: Row[] = [];
  const orderDraftRows: Row[] = [];
  const deliveryRuleRows: Row[] = [];
  const humanHandoffRows: Row[] = [];
  const automationRows: Row[] = [];
  const automationVersionRows: Row[] = [];
  const automationExecutionRows: Row[] = [];
  const userRows: Row[] = [];
  const followUpRows: Row[] = [];
  const workspaceUsageRows: Row[] = [];
  const dailyAnalyticsRows: Row[] = [];
  const playgroundSessionRows: Row[] = [];
  const playgroundMessageRows: Row[] = [];
  const salesEventRows: Row[] = [];
  const discountApprovalRows: Row[] = [];
  const audienceSegmentRows: Row[] = [];
  const campaignRows: Row[] = [];
  const campaignContentVersionRows: Row[] = [];
  const campaignRecipientRows: Row[] = [];
  const campaignEventRows: Row[] = [];
  const workspaceRows: Row[] = [];
  // P12
  const attributionTouchRows: Row[] = [];
  const integrationConnectionRows: Row[] = [];
  const integrationTokenRows: Row[] = [];
  const integrationDeliveryRows: Row[] = [];
  const agentDraftRows: Row[] = [];
  const agentCallLogRows: Row[] = [];
  const productComplianceRows: Row[] = [];
  const omsConnectionRows: Row[] = [];

  const db = {
    _stores: {
      customer, conversation, message, channelIdentity, channel, workspaceMember,
      auditLog, product, productVariant, productMedia, mediaAsset, feedback,
      order: orderRows, orderItem: orderItemRows, orderDraft: orderDraftRows, deliveryRule: deliveryRuleRows,
      channelAccount: channelAccountRows, webhookEvent: webhookEventRows, humanHandoff: humanHandoffRows, automation: automationRows, automationVersion: automationVersionRows, automationExecution: automationExecutionRows, user: userRows, followUp: followUpRows, workspaceUsage: workspaceUsageRows, dailyWorkspaceAnalytics: dailyAnalyticsRows,
      knowledgeDocument, knowledgeChunk, faq, backgroundJob,
      aISettings, persona, personaVersion, customerMemory, knowledgeCitation, aIUsageLog,
      playgroundSession: playgroundSessionRows, playgroundMessage: playgroundMessageRows,
      salesEvent: salesEventRows, discountApproval: discountApprovalRows,
      audienceSegment: audienceSegmentRows, campaign: campaignRows,
      campaignContentVersion: campaignContentVersionRows, campaignRecipient: campaignRecipientRows,
      campaignEvent: campaignEventRows,
      workspace: workspaceRows,
      attributionTouch: attributionTouchRows,
      integrationConnection: integrationConnectionRows,
      integrationToken: integrationTokenRows,
      integrationDelivery: integrationDeliveryRows,
      agentDraft: agentDraftRows,
      agentCallLog: agentCallLogRows,
      productCompliance: productComplianceRows,
      omsConnection: omsConnectionRows,
    },
    customer: makeModel("customer", customer, { status: "NEW_LEAD", tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null, leadScore: 0, marketingConsent: "UNKNOWN", marketingOptOutAt: null, marketingConsentAt: null }),
    conversation: makeModel("conversation", conversation, { status: "OPEN", aiState: "AI_ACTIVE", aiEnabled: true, priority: "NORMAL", unreadCount: 0, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    message: makeModel("message", message, { deliveryStatus: "PENDING", isNote: false, metadata: {}, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    channelIdentity: makeModel("channelIdentity", channelIdentity, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    channel: makeModel("channel", channel, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    workspaceMember: makeModel("workspaceMember", workspaceMember, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    auditLog: makeModel("auditLog", auditLog, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    product: makeModel("product", product, { currency: "USD", stockStatus: "IN_STOCK", stockQty: 0, tags: [], benefits: [], objections: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    productVariant: makeModel("productVariant", productVariant, { stockStatus: "IN_STOCK", stockQty: 0, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    productMedia: makeModel("productMedia", productMedia, { sortOrder: 0, isPrimary: false, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    mediaAsset: makeModel("mediaAsset", mediaAsset, { category: "OTHER", size: 0, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    feedback: makeModel("feedback", feedback, { kind: "TEXT", tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    knowledgeDocument: makeModel("knowledgeDocument", knowledgeDocument, { version: 1, isActive: true, isArchived: false, isApproved: false, deletedAt: null, tags: [] }),
    knowledgeChunk: makeModel("knowledgeChunk", knowledgeChunk, { tokenCount: 0, isActive: true, isArchived: false, isApproved: false, deletedAt: null, tags: [] }),
    faq: makeModel("faq", faq, { isActive: true, isArchived: false, isApproved: false, deletedAt: null, tags: [] }),
    backgroundJob: makeModel("backgroundJob", backgroundJob, { status: "PENDING", attempts: 0, maxAttempts: 3, runAfter: new Date(), tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    aISettings: makeModel("aISettings", aISettings, { provider: "mock", temperature: 0.4, maxTokens: 500, aiEnabled: true, autoRespond: true, customBaseUrl: null, fallbackProvider: null, fallbackModel: null }),
    persona: makeModel("persona", persona, { isActive: true, emojiLevel: 1, prohibitedPhrases: [], customRules: [], version: 1, tags: [], isArchived: false, isApproved: false, deletedAt: null }),
    personaVersion: makeModel("personaVersion", personaVersion, { status: "DRAFT", prohibitedPhrases: [], customRules: [], tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    customerMemory: makeModel("customerMemory", customerMemory, { confidence: 1, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    knowledgeCitation: makeModel("knowledgeCitation", knowledgeCitation, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    channelAccount: makeModel("channelAccount", channelAccountRows, { provider: "FACEBOOK", connectedAt: new Date(), tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    humanHandoff: makeModel("humanHandoff", humanHandoffRows, { priority: "NORMAL", status: "OPEN", tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    automation: makeModel("automation", automationRows, { priority: 0, isEnabled: true, conditions: {}, actions: [], status: "PUBLISHED", version: 1, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    automationVersion: makeModel("automationVersion", automationVersionRows, { priority: 0, conditions: {}, actions: [], tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    automationExecution: makeModel("automationExecution", automationExecutionRows, { status: "RUNNING", stepIndex: 0, attempts: 0, stepLog: [], metadata: {}, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    user: makeModel("user", userRows, { availability: "AVAILABLE", isSuperAdmin: false, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    followUp: makeModel("followUp", followUpRows, { status: "SCHEDULED", attempts: 0, type: "GENERIC", tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    workspaceUsage: makeModel("workspaceUsage", workspaceUsageRows, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    dailyWorkspaceAnalytics: makeModel("dailyWorkspaceAnalytics", dailyAnalyticsRows, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    webhookEvent: makeModel("webhookEvent", webhookEventRows, { source: "meta", channelType: "FACEBOOK", tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    playgroundSession: makeModel("playgroundSession", playgroundSessionRows, { useKnowledge: true, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    playgroundMessage: makeModel("playgroundMessage", playgroundMessageRows, { metadata: {}, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    aIUsageLog: makeModel("aIUsageLog", aIUsageLog, { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, success: true, status: "SUCCESS", personaId: null, personaVersion: null, fallbackUsed: false, handoffReason: null, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    order: makeModel("order", orderRows, { status: "NEW", confirmationStatus: "PENDING", paymentStatus: "UNPAID", fulfillmentStatus: "UNFULFILLED", subtotal: 0, discount: 0, deliveryFee: 0, total: 0, currency: "USD", source: "AI", tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    orderItem: makeModel("orderItem", orderItemRows, { tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    orderDraft: makeModel("orderDraft", orderDraftRows, { state: "COLLECTING", missingFields: [], phone: null, productId: null, quantity: null, rawAddress: null, province: null, customerName: null, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    deliveryRule: makeModel("deliveryRule", deliveryRuleRows, { fee: 0, isAvailable: true, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    salesEvent: makeModel("salesEvent", salesEventRows, { payload: {}, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    audienceSegment: makeModel("audienceSegment", audienceSegmentRows, { description: null, isActive: true, tags: [], isArchived: false, isApproved: false, deletedAt: null }),
    campaign: makeModel("campaign", campaignRows, { description: null, channelId: null, scheduledAt: null, timezone: "UTC", endsAt: null, ratePerMinute: 30, windowStartAt: null, sentInWindow: 0, contentVersionId: null, approvedBy: null, approvedAt: null, approvalAudienceHash: null, startedAt: null, completedAt: null, cancelledAt: null, cancelReason: null, failReason: null, lastTickSeq: 0, source: "manual", externalSystem: null, externalRef: null, externalIdempotencyKey: null, resultsSentAt: null, finalResultsSentAt: null, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    campaignContentVersion: makeModel("campaignContentVersion", campaignContentVersionRows, { templateName: null, templateLanguage: null, templateVariables: {}, status: "DRAFT", approvedBy: null, approvedAt: null, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    campaignRecipient: makeModel("campaignRecipient", campaignRecipientRows, { conversationId: null, excludeReason: null, messageId: null, attempts: 0, lastError: null, errorCategory: null, sentAt: null, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    campaignEvent: makeModel("campaignEvent", campaignEventRows, { actorUserId: null, reason: null, count: 0, payload: {}, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    discountApproval: makeModel("discountApproval", discountApprovalRows, { status: "PENDING", currency: "USD", tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    workspace: makeModel("workspace", workspaceRows, { plan: "FREE", timezone: "UTC", integrationSettings: {}, tags: [], isActive: true, isArchived: false, isApproved: false, deletedAt: null }),
    // P12 — نماذج الربط مع المنظومة وباب الوكلاء.
    attributionTouch: makeModel("attributionTouch", attributionTouchRows, { episodeStart: false, adId: null, adSourceType: null, ctwaClidEnc: null, refCode: null, codeStatus: null, codeProductCode: null, codeCampaignRef: null, codeWindowDays: null, pageId: null, psidEnc: null, wabaId: null, messageId: null }),
    integrationConnection: makeModel("integrationConnection", integrationConnectionRows, { baseUrl: null, tokenEncrypted: null, eventsUrl: null, eventsSecretEncrypted: null, enabled: true, settings: {}, lastOkAt: null, lastErrorAt: null, lastError: null }),
    integrationToken: makeModel("integrationToken", integrationTokenRows, { scopes: [], rateLimitPerMin: 60, dailyDraftCap: 20, expiresAt: null, revokedAt: null, lastUsedAt: null }),
    integrationDelivery: makeModel("integrationDelivery", integrationDeliveryRows, { method: "POST", eventId: null, idempotencyKey: null, status: "PENDING", attempts: 0, nextAttemptAt: null, responseCode: null, error: null, deliveredAt: null }),
    agentDraft: makeModel("agentDraft", agentDraftRows, { tokenId: null, payload: {}, status: "PENDING", idempotencyKey: null, resultRef: null, decidedBy: null, decidedAt: null, decisionNote: null, expiresAt: null }),
    agentCallLog: makeModel("agentCallLog", agentCallLogRows, { tokenId: null, errorCode: null, requestId: null, agentRef: null, dryRun: false, latencyMs: 0 }),
    productCompliance: makeModel("productCompliance", productComplianceRows, { classification: null, verdict: null, allowedClaims: [], bannedClaims: [], adRules: [], sourceUpdatedAt: null, fetchedAt: null, lastError: null }),
    omsConnection: makeModel("omsConnection", omsConnectionRows, { isActive: true, lastProductSyncAt: null, lastCustomerSyncAt: null, mode: "api", apiVersion: "legacy", webhookSecretEncrypted: null, webhookKey: null, autoHandoff: false, lastWebhookAt: null, lastOkAt: null, lastErrorAt: null, lastError: null }),
  };

  const conversationModel = db.conversation as any;
  const baseConvFindUnique = conversationModel.findUnique.bind(conversationModel);
  conversationModel.findUnique = async (args: any) => {
    const row = await baseConvFindUnique(args);
    if (!row) return row;
    const inc = args?.include ?? {};
    if (inc.channel) {
      const ch = channel.find((c) => c.id === row.channelId) ?? null;
      if (ch) {
        ch.account = channelAccountRows.find((a) => a.channelId === ch.id) ?? null;
      }
      row.channel = ch;
    }
    return row;
  };

  // findMany: hydrate the same relations Prisma would (customer + nested
  // identities, channel + account), since list endpoints select them.
  const baseConvFindMany = conversationModel.findMany.bind(conversationModel);
  conversationModel.findMany = async (args: any) => {
    const rows = (await baseConvFindMany(args)) as any[];
    const inc = args?.include ?? {};
    for (const row of rows) {
      if (inc.customer) {
        const cust = customer.find((c) => c.id === row.customerId) ?? null;
        if (cust) {
          const fromStore = channelIdentity.filter((i) => i.customerId === cust.id);
          const nested = Array.isArray((cust as Row).identities) ? (cust as Row).identities : [];
          const seen = new Set<string>();
          const merged: Row[] = [];
          for (const i of [...fromStore, ...nested]) {
            if (i?.id && !seen.has(i.id)) {
              seen.add(i.id);
              merged.push(i);
            }
          }
          cust.identities = merged;
        }
        row.customer = cust;
      }
      if (inc.channel) {
        const ch = channel.find((c) => c.id === row.channelId) ?? null;
        if (ch) {
          ch.account = channelAccountRows.find((a) => a.channelId === ch.id) ?? null;
        }
        row.channel = ch;
      }
    }
    return rows;
  };

  // message idempotency unique constraints (mirrors real Postgres behavior)
  const baseMessageCreate = (db.message as any).create.bind(db.message);  (db.message as any).create = async (args: any) => {
    const d = args.data ?? {};
    for (const [key, field] of [["conversationId_externalEventId", "externalEventId"], ["conversationId_externalMessageId", "externalMessageId"]] as const) {
      const v = d[field];
      if (v) {
        const dup = message.find(
          (m) => m.conversationId === d.conversationId && m[field] === v
        );
        if (dup) {
          const err = new Error(`Unique constraint failed: ${key}`) as Error & { code?: string };
          err.code = "P2002";
          throw err;
        }
      }
    }
    return baseMessageCreate(args);
  };

  // conversation unique [workspaceId, channelConversationId] → P2002
  // (concurrent first-message race mirrors real Postgres behavior).
  const baseConvCreate = (db.conversation as any).create.bind(db.conversation);  (db.conversation as any).create = async (args: any) => {
    const d = args.data ?? {};
    if (d.workspaceId && d.channelConversationId) {
      const dup = conversation.find(
        (c) => c.workspaceId === d.workspaceId && c.channelConversationId === d.channelConversationId
      );
      if (dup) {
        const err = new Error("Unique constraint failed: workspaceId_channelConversationId") as Error & { code?: string };
        err.code = "P2002";
        throw err;
      }
    }
    return baseConvCreate(args);
  };

  // channel partial unique (workspaceId, type) WHERE externalId IS NULL
  // (P5 gate — mirrors migration 20261010090441_p5_channel_auto_unique).
  const baseChannelCreate = (db.channel as any).create.bind(db.channel);
  (db.channel as any).create = async (args: any) => {
    const d = args.data ?? {};
    if (d.workspaceId && d.type && (d.externalId === undefined || d.externalId === null)) {
      const dup = channel.find(
        (c) => c.workspaceId === d.workspaceId && c.type === d.type && (c.externalId === undefined || c.externalId === null)
      );
      if (dup) {
        const err = new Error("Unique constraint failed: Channel_workspace_type_null_external_idx") as Error & { code?: string };
        err.code = "P2002";
        throw err;
      }
    }
    return baseChannelCreate(args);
  };

  // channelIdentity unique [channelType, channelExternalId] → P2002.
  const baseIdentityCreate = (db.channelIdentity as any).create.bind(db.channelIdentity);  (db.channelIdentity as any).create = async (args: any) => {
    const d = args.data ?? {};
    if (d.channelType && d.channelExternalId) {
      const dup = channelIdentity.find(
        (i) => i.channelType === d.channelType && i.channelExternalId === d.channelExternalId
      );
      if (dup) {
        const err = new Error("Unique constraint failed: channelType_channelExternalId") as Error & { code?: string };
        err.code = "P2002";
        throw err;
      }
    }
    return baseIdentityCreate(args);
  };

  // webhookEvent unique [source, externalEventId] → throw on duplicate
  const baseWebhookCreate = (db.webhookEvent as any).create.bind(db.webhookEvent);
  (db.webhookEvent as any).create = async (args: any) => {
    const dup = webhookEventRows.find(
      (w) => w.source === args.data?.source && w.externalEventId === args.data?.externalEventId
    );
    if (dup) {
      const err = new Error("Unique constraint failed: source_externalEventId") as Error & { code?: string };
      err.code = "P2002";
      throw err;
    }
    return baseWebhookCreate(args);
  };

  // backgroundJob PARTIAL unique index (migration 20260929000000): at most one
  // ACTIVE (PENDING/PROCESSING) job per idempotencyKey — mirrors the real DB.
  const baseJobCreate = (db.backgroundJob as any).create.bind(db.backgroundJob);
  (db.backgroundJob as any).create = async (args: any) => {
    const key = args.data?.idempotencyKey;
    if (key) {
      const dup = backgroundJob.find(
        (j) => j.idempotencyKey === key && (j.status === "PENDING" || j.status === "PROCESSING")
      );
      if (dup) {
        const err = new Error("Unique constraint failed: BackgroundJob_idempotencyKey_active_key") as Error & { code?: string };
        err.code = "P2002";
        throw err;
      }
    }
    return baseJobCreate(args);
  };
  const baseJobFindUnique = (db.backgroundJob as any).findUnique.bind(db.backgroundJob);
  (db.backgroundJob as any).findUnique = async (args: any) => {
    const key = args?.where?.idempotencyKey;
    if (key) {
      const row = backgroundJob.find((j) => j.idempotencyKey === key);
      return row ?? null;
    }
    return baseJobFindUnique(args);
  };

  // automationExecution unique [automationId, triggerEventId] → throw on duplicate
  const baseExecCreate = (db.automationExecution as any).create.bind(db.automationExecution);
  (db.automationExecution as any).create = async (args: any) => {
    const dup = automationExecutionRows.find(
      (e) => e.automationId === args.data?.automationId && e.triggerEventId === args.data?.triggerEventId
    );
    if (dup) {
      const err = new Error("Unique constraint failed") as Error & { code?: string };
      err.code = "P2002";
      throw err;
    }
    return baseExecCreate(args);
  };

  // Hydrate orderItem.order for product analytics.
  const orderItemModel = db.orderItem as any;
  const baseItemFindMany = orderItemModel.findMany.bind(orderItemModel);
  orderItemModel.findMany = async (args: any) => {
    const rows = (await baseItemFindMany(args)) as any[];
    if (args?.include?.order) {
      for (const row of rows) row.order = orderRows.find((o) => o.id === row.orderId) ?? null;
    }
    return rows;
  };

  // Hydrate workspaceMember.user for handoff routing.
  const memberModel = db.workspaceMember as any;
  const baseMemberFindMany = memberModel.findMany.bind(memberModel);
  memberModel.findMany = async (args: any) => {
    const rows = (await baseMemberFindMany(args)) as any[];
    if (args?.include?.user) {
      for (const row of rows) row.user = userRows.find((u) => u.id === row.userId) ?? null;
    }
    return rows;
  };

  // Hydrate channelAccount.channel for webhook routing.
  const channelAccountModel = db.channelAccount as any;
  const baseAccountFindFirst = channelAccountModel.findFirst.bind(channelAccountModel);
  channelAccountModel.findFirst = async (args: any) => {
    const row = await baseAccountFindFirst(args);
    if (!row) return row;
    const inc = args?.include ?? {};
    if (inc.channel) {
      const ch = channel.find((c) => c.id === row.channelId) ?? null;
      if (ch) row.channel = ch;
    }
    return row;
  };

  // Hydrate order.items include.
  const orderModel = db.order as any;
  const baseOrderFindUnique = orderModel.findUnique.bind(orderModel);
  orderModel.findUnique = async (args: any) => {
    const row = await baseOrderFindUnique(args);
    if (!row) return row;
    const inc = args?.include ?? {};
    if (inc.items) row.items = orderItemRows.filter((i) => i.orderId === row.id);
    if (inc.customer) row.customer = customer.find((c) => c.id === row.customerId) ?? null;
    return row;
  };
  const baseOrderFindMany = orderModel.findMany.bind(orderModel);
  orderModel.findMany = async (args: any) => {
    const rows = (await baseOrderFindMany(args)) as any[];
    const inc = args?.include ?? {};
    for (const row of rows) {
      if (inc.items) row.items = orderItemRows.filter((i) => i.orderId === row.id);
      if (inc.customer) row.customer = customer.find((c) => c.id === row.customerId) ?? null;
    }
    return rows;
  };

  // Hydrate include relations for product detail queries.
  const productModel = db.product as any;
  const baseProductFindUnique = productModel.findUnique.bind(productModel);
  productModel.findUnique = async (args: any) => {
    const row = await baseProductFindUnique(args);
    if (!row) return row;
    const inc = args?.include ?? {};
    if (inc.mediaLinks) {
      row.mediaLinks = productMedia
        .filter((l) => l.productId === row.id)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder)
        .map((l) => ({ ...l, mediaAsset: mediaAsset.find((m) => m.id === l.mediaAssetId) ?? null }));
    }
    if (inc.faqs) row.faqs = faq.filter((f) => f.productId === row.id && f.isActive);
    if (inc.variants) row.variants = productVariant.filter((v) => v.productId === row.id);
    return row;
  };

  const docModel = db.knowledgeDocument as any;
  const baseDocFindUnique = docModel.findUnique.bind(docModel);
  docModel.findUnique = async (args: any) => {
    const row = await baseDocFindUnique(args);
    if (!row) return row;
    if (args?.include?.chunks) {
      row.chunks = knowledgeChunk
        .filter((c) => c.documentId === row.id && c.isActive)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    }
    return row;
  };

  // Simulate nested writes: customer.create({ data: { identities: { create } } })
  const baseCustomerCreate = db.customer.create.bind(db.customer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.customer as any).create = async (args: any) => {
    const nested = args.data?.identities?.create;
    const result = await baseCustomerCreate(args);
    if (nested) {
      channelIdentity.push({
        id: `ci-${channelIdentity.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        customerId: result.id,
        ...nested,
      });
    }
    return result;
  };

  // order.create({ data: { items: { create: [...] } } }) → orderItem rows
  const baseOrderCreate = (db.order as any).create.bind(db.order);
  (db.order as any).create = async (args: any) => {
    const items = args.data?.items?.create;
    if (items) delete args.data.items;
    const result = await baseOrderCreate(args);
    for (const item of Array.isArray(items) ? items : items ? [items] : []) {
      orderItemRows.push({
        id: `oi-${orderItemRows.length + 1}`,
        createdAt: new Date(),
        orderId: result.id,
        ...item,
      });
    }
    return result;
  };

  allStores = db._stores;
  return db;
}
