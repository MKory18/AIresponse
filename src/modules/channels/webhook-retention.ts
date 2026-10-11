import { childLogger } from "@/core/logger";
import type { Db } from "@/modules/customers/service";

const log = childLogger("channels.webhook-retention");

/**
 * مدة الاحتفاظ بحمولة أحداث القنوات الخام.
 *
 * `WebhookEvent.payload` بيحفظ حمولة ميتا كما هي: رقم الزبون · نص رسالته ·
 * رمز نقرة الإعلان. كانت تنحفظ **بلا مدة** — يعني كل رقم ونص مرّ على النظام
 * بيضل مخزّن للأبد. هالكنس بيفرّغ الحمولة بعد مدة الاحتفاظ.
 *
 * **الصف نفسه ما بينحذف أبدًا:** عدم تكرار الأحداث معتمد على
 * `(source, externalEventId)` — حذف الصف معناه إن إعادة قديمة من ميتا
 * بتنعالج من جديد (رد مكرر للزبون). فالي بينشال المحتوى بس.
 */
export const DEFAULT_RETENTION_DAYS = 30;
const MAX_PER_RUN = 500;

/** `0` = الكنس مطفي (الحمولة بتضل) · بلا قيمة = 30 يوم. */
export function retentionDays(): number {
  const raw = process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log.warn({ raw }, "webhook_retention_invalid_using_default");
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.floor(n);
}

export interface PurgeResult {
  purged: number;
  disabled?: boolean;
}

/**
 * بيفرّغ حمولة الأحداث الي خلصت معالجتها (أو فشلت نهائيًا) وأقدم من المدة.
 * الأحداث الي لسا عم تنعالج (بلا `processedAt` وبلا خطأ) بتضل بحمولتها حتى
 * الإعادة تقدر تشتغل — ⚠️ يعني حدث معلّق للأبد بيضل محتفظ بحمولته.
 */
export async function purgeOldWebhookPayloads(
  db: Db,
  now = new Date(),
  limit = MAX_PER_RUN
): Promise<PurgeResult> {
  const days = retentionDays();
  if (days === 0) return { purged: 0, disabled: true };
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const rows = (await db.webhookEvent.findMany({
    where: {
      payloadPurgedAt: null,
      createdAt: { lt: cutoff },
      // المعالجة خلصت، أو فشلت وما عاد في إعادة بعد كل هالمدة.
      OR: [{ processedAt: { not: null } }, { error: { not: null } }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  })) as Array<{ id: string }>;
  if (rows.length === 0) return { purged: 0 };

  let purged = 0;
  for (const r of rows) {
    try {
      await db.webhookEvent.update({
        where: { id: r.id },
        // ولا رقم ولا نص ولا رمز نقرة بيضل — ختم المدة بس.
        data: { payload: { purged: true }, payloadPurgedAt: now },
      });
      purged += 1;
    } catch (err) {
      log.warn({ id: r.id, error: err instanceof Error ? err.message : String(err) }, "webhook_payload_purge_failed");
    }
  }
  log.info({ purged, days, cutoff: cutoff.toISOString() }, "webhook_payloads_purged");
  return { purged };
}
