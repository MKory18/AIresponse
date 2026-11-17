import { childLogger } from "@/core/logger";
import { enqueueJob, type Db } from "@/modules/jobs/service";
import { getIntegrationSettings } from "@/modules/integrations/settings";

const log = childLogger("order-reader");

/**
 * جدولة قراءة المحادثة (الحزمة 1.3).
 *
 * - `LEGACY_DRAFT` (الافتراضي) = ولا مهمة بتنصف: الموقع بيشتغل بالمسودة القديمة بالحرف.
 * - الباقي (`READER_SHADOW` · `READER`) = مهمة `read_conversation` مؤجّلة 45 ثانية.
 *   كل رسالة جديدة بتصف مهمة بمفتاحها، والمعالج بيتخطّى القديمة (الـ debounce):
 *   3 رسائل متتالية = قراءة وحدة.
 * - بتنادى من `processIncomingMessage` (رسالة العميل) ومن `sendHumanReply` (رد الموظف)
 *   — للوضعين، وبغض النظر عن من ماسك المحادثة. فشلها ما بيوقف رسالة ولا رد أبدًا.
 */
export const READ_DEBOUNCE_MS = 45_000;

export type OrderMode = "LEGACY_DRAFT" | "READER_SHADOW" | "READER";

export async function getOrderMode(db: Db, workspaceId: string): Promise<OrderMode> {
  try {
    const s = (await getIntegrationSettings(db, workspaceId)) as { orderMode?: string };
    return s.orderMode === "READER_SHADOW" || s.orderMode === "READER" ? s.orderMode : "LEGACY_DRAFT";
  } catch {
    // تعذّر قراءة الإعدادات = الوضع القديم (فشل آمن).
    return "LEGACY_DRAFT";
  }
}

export interface ScheduleReadInput {
  workspaceId: string;
  conversationId: string;
  /** آخر رسالة (عميل أو موظف) سببت هالقراءة. */
  messageId: string;
  /** مين سبّب القراءة: رسالة عميل (الافتراضي) أو رد موظف. */
  trigger?: "CUSTOMER" | "STAFF";
  now?: Date;
}

export interface ScheduleReadResult {
  scheduled: boolean;
  reason?: "LEGACY_DRAFT" | "ENQUEUE_FAILED";
}

export async function scheduleConversationRead(db: Db, input: ScheduleReadInput): Promise<ScheduleReadResult> {
  const mode = await getOrderMode(db, input.workspaceId);
  if (mode === "LEGACY_DRAFT") return { scheduled: false, reason: "LEGACY_DRAFT" };
  const trigger = input.trigger ?? "CUSTOMER";
  const now = input.now ?? new Date();
  try {
    await enqueueJob(db, {
      workspaceId: input.workspaceId,
      type: "read_conversation",
      payload: { conversationId: input.conversationId, throughMessageId: input.messageId, trigger },
      runAfter: new Date(now.getTime() + READ_DEBOUNCE_MS),
      idempotencyKey: `read:${input.workspaceId}:${input.conversationId}:${input.messageId}`,
      maxAttempts: 4,
    });
    return { scheduled: true };
  } catch (err) {
    log.warn({ conversationId: input.conversationId, error: err instanceof Error ? err.message : String(err) }, "read_enqueue_failed");
    return { scheduled: false, reason: "ENQUEUE_FAILED" };
  }
}
