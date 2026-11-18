import type { Db } from "@/modules/jobs/service";
import type { VerifiedReading } from "./verify";
import type { OrderMode } from "./schedule";

/**
 * تطبيق القراءة (الحزمة 1.3 = فرع الظل فقط).
 *
 * `READER_SHADOW` (و`READER` لحد الحزمة 1.4): بنحفظ `ConversationReading` بس.
 * ⚠️ ممنوع هون: أي كتابة على `Order` · أي رسالة · أي تغيير بمسار الرد.
 * إنشاء الطلب وتحديثه وتثبيته بيجي بالحزمة 1.4 داخل `$transaction`.
 */
export interface SaveReadingInput {
  workspaceId: string;
  conversationId: string;
  mode: OrderMode;
  verified: VerifiedReading;
  /** آخر رسالة العميل اللي غطّتها هالقراءة. */
  readThroughMessageId: string;
  readThroughAt: Date;
  now?: Date;
}

type ReadingRow = {
  id: string;
  version: number;
  firstInterestedAt: Date | null;
  firstOrderingAt: Date | null;
} | null;

export async function saveShadowReading(db: Db, input: SaveReadingInput): Promise<{ version: number }> {
  const now = input.now ?? new Date();
  const d = db as unknown as {
    conversationReading: {
      findUnique: (a: unknown) => Promise<ReadingRow>;
      create: (a: unknown) => Promise<unknown>;
      update: (a: unknown) => Promise<unknown>;
    };
  };
  const existing = await d.conversationReading.findUnique({ where: { conversationId: input.conversationId } });
  const stage = input.verified.stage;
  const data = {
    stage,
    readThroughMessageId: input.readThroughMessageId,
    readThroughAt: input.readThroughAt,
    data: JSON.parse(JSON.stringify(input.verified)),
    missing: input.verified.missing,
    flags: input.verified.flags,
    status: "DONE",
    attempts: 0,
    lastError: null,
    readAt: now,
    ...(stage !== "NONE" && !existing?.firstInterestedAt ? { firstInterestedAt: now } : {}),
    ...((stage === "COLLECTING" || stage === "COMPLETE") && !existing?.firstOrderingAt ? { firstOrderingAt: now } : {}),
  };
  if (existing) {
    const version = existing.version + 1;
    await d.conversationReading.update({ where: { id: existing.id }, data: { ...data, version } });
    return { version };
  }
  await d.conversationReading.create({
    data: { workspaceId: input.workspaceId, conversationId: input.conversationId, version: 1, ...data },
  });
  return { version: 1 };
}

/** قراءة بلا نداء (الفلتر قرّر ما في شي يشبه الطلب): بتسجّل التغطية بس. */
export async function saveNoneReading(
  db: Db,
  input: { workspaceId: string; conversationId: string; readThroughMessageId: string; readThroughAt: Date; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const d = db as unknown as {
    conversationReading: {
      findUnique: (a: unknown) => Promise<ReadingRow>;
      create: (a: unknown) => Promise<unknown>;
      update: (a: unknown) => Promise<unknown>;
    };
  };
  const existing = await d.conversationReading.findUnique({ where: { conversationId: input.conversationId } });
  const base = {
    readThroughMessageId: input.readThroughMessageId,
    readThroughAt: input.readThroughAt,
    status: "DONE",
    attempts: 0,
    lastError: null,
    readAt: now,
  };
  if (existing) {
    // لا نمسح قراءة سابقة بمرحلة أعلى: نسجّل التغطية بس.
    await d.conversationReading.update({ where: { id: existing.id }, data: base });
    return;
  }
  await d.conversationReading.create({
    data: { workspaceId: input.workspaceId, conversationId: input.conversationId, version: 1, stage: "NONE", ...base },
  });
}

export async function markReadingFailed(
  db: Db,
  input: { workspaceId: string; conversationId: string; error: string }
): Promise<void> {
  const d = db as unknown as {
    conversationReading: {
      findUnique: (a: unknown) => Promise<(ReadingRow & { attempts?: number }) | null>;
      create: (a: unknown) => Promise<unknown>;
      update: (a: unknown) => Promise<unknown>;
    };
  };
  const existing = await d.conversationReading.findUnique({ where: { conversationId: input.conversationId } });
  const lastError = input.error.slice(0, 300);
  if (existing) {
    await d.conversationReading.update({
      where: { id: existing.id },
      data: { status: "FAILED", lastError, attempts: (existing.attempts ?? 0) + 1 },
    });
    return;
  }
  await d.conversationReading.create({
    data: { workspaceId: input.workspaceId, conversationId: input.conversationId, version: 0, stage: "NONE", status: "FAILED", lastError, attempts: 1 },
  });
}
