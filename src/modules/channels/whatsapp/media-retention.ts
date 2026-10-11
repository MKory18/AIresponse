import { childLogger } from "@/core/logger";
import { getStorage } from "@/modules/media/storage";
import { CUSTOMER_INBOUND } from "@/modules/media/service";
import type { Db } from "@/modules/customers/service";

const log = childLogger("channels.whatsapp.media-retention");

/**
 * مدة الاحتفاظ بوسائط الزبون الواردة.
 *
 * صور الزبون ومستنداته وبصماته الصوتية بتتخزّن عندنا على القرص. بلا مدة،
 * بتضل للأبد. هالكنس بيحذف **الملف وصف الوسيط** بعد المدة، والرسالة بتحتفظ
 * بعلامة «الوسيط انتهى» حتى الموظف يعرف إنه كان في وسيط ومش إنه ضاع.
 *
 * ⚠️ مؤتمت: الحذف نهائي وما بينرجع. 🔧 المدة بالإعداد
 * `WA_MEDIA_RETENTION_DAYS` (افتراضي 180 · `0` = الكنس مطفي).
 */
export const DEFAULT_WA_MEDIA_RETENTION_DAYS = 180;
const MAX_PER_RUN = 300;

export function waMediaRetentionDays(): number {
  const raw = process.env.WA_MEDIA_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_WA_MEDIA_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log.warn({ raw }, "wa_media_retention_invalid_using_default");
    return DEFAULT_WA_MEDIA_RETENTION_DAYS;
  }
  return Math.floor(n);
}

export interface WaMediaPurgeResult {
  deleted: number;
  disabled?: boolean;
}

/**
 * بيحذف ملفات وسائط الزبون الأقدم من المدة + صفوفها، وبيختم الرسالة بعلامة.
 * الرسالة نفسها ما بتنلمس غير `mediaUrl` (بيصير فاضي لأن الملف انحذف فعلًا)
 * وعلامة بالـ metadata.
 */
export async function purgeOldCustomerMedia(
  db: Db,
  now = new Date(),
  limit = MAX_PER_RUN
): Promise<WaMediaPurgeResult> {
  const days = waMediaRetentionDays();
  if (days === 0) return { deleted: 0, disabled: true };
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const assets = (await db.mediaAsset.findMany({
    where: { category: CUSTOMER_INBOUND, createdAt: { lt: cutoff } },
    select: { id: true, storageKey: true, workspaceId: true, messageId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  })) as Array<{ id: string; storageKey: string; workspaceId: string; messageId: string | null }>;
  if (assets.length === 0) return { deleted: 0 };

  const storage = getStorage();
  let deleted = 0;
  for (const a of assets) {
    try {
      // الملف أولًا: لو فشل الحذف، الصف يضل ويُعاد بالدورة الجاية (ولا ملف يتيم).
      await storage.delete(a.storageKey);
      if (a.messageId) {
        const msg = (await db.message.findUnique({
          where: { id: a.messageId },
          select: { id: true, metadata: true },
        })) as { id: string; metadata?: unknown } | null;
        if (msg) {
          const metadata = (msg.metadata ?? {}) as Record<string, unknown>;
          await db.message.update({
            where: { id: msg.id },
            data: {
              mediaUrl: null,
              metadata: { ...metadata, waMediaExpiredAt: now.toISOString() },
            },
          });
        }
      }
      await db.mediaAsset.delete({ where: { id: a.id } });
      deleted += 1;
    } catch (err) {
      log.warn(
        { mediaId: a.id, workspaceId: a.workspaceId, error: err instanceof Error ? err.message : String(err) },
        "wa_media_purge_failed"
      );
    }
  }
  log.info({ deleted, days, cutoff: cutoff.toISOString() }, "wa_media_purged");
  return { deleted };
}
