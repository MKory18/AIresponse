import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/inmemory-db";
import { processIncomingMessage } from "@/modules/conversations/service";
import { buildExtractionPrompt, runCustomerIntelExtraction } from "@/modules/intelligence/service";
import { requiredProgress } from "@/modules/intelligence/fields";
import {
  DEFAULT_COLLECTION_FIELDS,
  enabledFieldDefs,
  getCollectionFields,
  normalizeCollectionFields,
  saveCollectionFields,
  type CollectionFieldSetting,
} from "@/modules/intelligence/settings";

type FakeDb = ReturnType<typeof createFakeDb> & Record<string, any>;

const originalFetch = global.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;

function completion(fields: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(fields) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function seedPage(db: FakeDb) {
  db._stores.channel.push({
    id: "ch1",
    workspaceId: "ws1",
    type: "FACEBOOK",
    status: "CONNECTED",
    displayName: "صفحة الاختبار",
    sendMode: "COLLECTION_ONLY",
  });
}

function inbound(db: FakeDb, text: string) {
  return processIncomingMessage(db as never, {
    workspaceId: "ws1",
    channelType: "FACEBOOK",
    channelId: "ch1",
    externalUserId: "psid-1",
    externalConversationId: "psid-1",
    externalMessageId: `mid-${Math.random().toString(36).slice(2, 8)}`,
    externalEventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
    provider: "facebook",
    type: "TEXT",
    text,
  });
}

/** إعداد كامل: الكتالوج الافتراضي مع تعديلات محدّدة. */
function settingsWith(patch: Record<string, Partial<CollectionFieldSetting>>, extra: CollectionFieldSetting[] = []): CollectionFieldSetting[] {
  const base = DEFAULT_COLLECTION_FIELDS.map((f) => ({ ...f, ...(patch[f.key] ?? {}) }));
  return [...base, ...extra];
}

async function extract(db: FakeDb, text: string, fields: Record<string, unknown>) {
  seedPage(db);
  const { messageId } = await inbound(db, text);
  global.fetch = vi.fn(async () =>
    completion({ ...fields, confidence: 0.9, sourceMessageIds: [messageId] })
  ) as never;
  const out = await runCustomerIntelExtraction(db as never, { workspaceId: "ws1", messageId });
  return { out, messageId };
}

function intelRow(db: FakeDb) {
  return (db._stores.customerIntel as Array<Record<string, any>>)[0];
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  delete process.env.OPENROUTER_BASE_URL;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  delete process.env.OPENROUTER_BASE_URL;
});

describe("البيانات المطلوب تجميعها — الإعداد الافتراضي", () => {
  it("الافتراضي هو كتالوج كامل: الطلبية موجودة والرقم مطلوب", async () => {
    const db = createFakeDb() as FakeDb;
    const fields = await getCollectionFields(db as never, "ws1");
    expect(fields.map((f) => f.key)).toContain("order");
    expect(fields.find((f) => f.key === "order")?.label).toBe("الطلبية");
    expect(fields.find((f) => f.key === "phone")?.required).toBe(true);
    expect(fields.every((f) => f.enabled)).toBe(true);
  });

  it("الحقول القياسية تحافظ على نوعها حتى لو أرسل المالك نوعًا خاطئًا", () => {
    const parsed = normalizeCollectionFields([
      { key: "customerName", label: "اسم العميل", kind: "NUMBER", required: true, enabled: true },
      { key: "color", label: "اللون", kind: "LIST", required: true, enabled: true },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fields.find((f) => f.key === "customerName")?.kind).toBe("TEXT");
    expect(parsed.fields.find((f) => f.key === "customerName")?.label).toBe("اسم العميل");
    expect(parsed.fields.find((f) => f.key === "color")?.isCustom).toBe(true);
    expect(parsed.fields.find((f) => f.key === "color")?.kind).toBe("LIST");
  });

  it("يرفض المفاتيح غير الصالحة والتكرار وكل الحقول معطّلة", () => {
    expect(normalizeCollectionFields([]).ok).toBe(false);
    expect(normalizeCollectionFields([{ key: "bad key!", label: "س", kind: "TEXT", required: true, enabled: true }]).ok).toBe(false);
    expect(
      normalizeCollectionFields([
        { key: "color", label: "اللون", kind: "TEXT", required: true, enabled: true },
        { key: "color", label: "اللون 2", kind: "TEXT", required: true, enabled: true },
      ]).ok
    ).toBe(false);
    expect(
      normalizeCollectionFields([{ key: "customerName", label: "الاسم", kind: "TEXT", required: true, enabled: false }]).ok
    ).toBe(false);
  });
});

describe("الحقول القابلة للضبط — الاستخراج", () => {
  it("الحقل المعطّل لا يُطلب ولا يُحفظ حتى لو رجّعه الموديل", async () => {
    const db = createFakeDb() as FakeDb;
    await saveCollectionFields(
      db as never,
      "ws1",
      settingsWith({ budget: { enabled: false, required: false } }).map((f) => ({ ...f }))
    );

    const { out } = await extract(db, "اسمي سامر وبدي عطر، ميزانيتي 50 دينار", {
      customerName: "سامر",
      products: ["عطر"],
      budget: "50 دينار",
    });

    expect(out.status).toBe("DONE");
    const row = intelRow(db);
    expect(row.data.customerName).toBe("سامر");
    expect(row.data.budget ?? null).toBeNull();
    expect(row.fieldMeta.budget?.status ?? "MISSING").toBe("MISSING");
  });

  it("الحقل الخاص يُستخرج ويُحفظ تلقائيًا", async () => {
    const db = createFakeDb() as FakeDb;
    await saveCollectionFields(
      db as never,
      "ws1",
      settingsWith(
        { budget: { enabled: false, required: false } },
        [{ key: "color", label: "اللون", kind: "LIST", required: true, enabled: true, sortOrder: 99, isCustom: true }]
      )
    );

    const { out } = await extract(db, "بدي عطر أحمر", {
      products: ["عطر"],
      color: ["أحمر"],
    });

    expect(out.status).toBe("DONE");
    const row = intelRow(db);
    expect(row.data.color).toEqual(["أحمر"]);
    expect(row.fieldMeta.color.status).toBe("EXTRACTED");
  });

  it("قيمة الحقل الخاص غير المذكورة بالنص تُسقط (لا اختراع)", async () => {
    const db = createFakeDb() as FakeDb;
    await saveCollectionFields(
      db as never,
      "ws1",
      settingsWith(
        { budget: { enabled: false, required: false } },
        [{ key: "color", label: "اللون", kind: "LIST", required: true, enabled: true, sortOrder: 99, isCustom: true }]
      )
    );

    const { out } = await extract(db, "بدي عطر أحمر", {
      products: ["عطر"],
      color: ["أزرق"],
    });

    expect(out.status).toBe("DONE");
    expect(intelRow(db).data.color).toEqual([]);
  });

  it("إعدادات مساحة لا تتسرّب لمساحة ثانية", async () => {
    const db = createFakeDb() as FakeDb;
    await saveCollectionFields(
      db as never,
      "ws1",
      settingsWith({ customerName: { enabled: false, required: false } })
    );

    const ws1 = await getCollectionFields(db as never, "ws1");
    const ws2 = await getCollectionFields(db as never, "ws2");
    expect(ws1.find((f) => f.key === "customerName")?.enabled).toBe(false);
    expect(ws2.find((f) => f.key === "customerName")?.enabled).toBe(true);
    expect(ws2.every((f) => f.enabled)).toBe(true);
  });

  it("برومبت الاستخراج يذكر الحقول المفعّلة فقط", () => {
    const defs = enabledFieldDefs(settingsWith({ budget: { enabled: false }, notes: { enabled: false } }));
    const prompt = buildExtractionPrompt([{ id: "m1", text: "بدي عطر" }], defs, new Date("2026-10-21T00:00:00Z"));
    expect(prompt.system).toContain("order (الطلبية)");
    expect(prompt.system).not.toContain("budget (");
    expect(prompt.system).not.toContain("notes (");
  });
});

describe("تقدّم البيانات المطلوبة", () => {
  it("يحسب المجمّع من المطلوب ويسمّي الناقص", () => {
    const defs = enabledFieldDefs(DEFAULT_COLLECTION_FIELDS);
    const progress = requiredProgress({ customerName: "سامر", products: ["عطر"] }, defs);
    expect(progress.required).toBe(6);
    expect(progress.filled).toBe(2);
    expect(progress.missing).toEqual(["phone", "address", "order", "quantity"]);
  });

  it("القيمة الفارغة أو unknown لا تُحسب مجمّعة", () => {
    const defs = enabledFieldDefs(DEFAULT_COLLECTION_FIELDS);
    const progress = requiredProgress({ customerName: "", phone: "   ", products: [], quantity: null }, defs);
    expect(progress.filled).toBe(0);
    expect(progress.missing).toHaveLength(6);
  });
});
