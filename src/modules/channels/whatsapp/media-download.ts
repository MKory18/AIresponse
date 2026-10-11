import { decryptSecret } from "@/core/crypto";
import { childLogger } from "@/core/logger";
import { getWhatsAppClient, WhatsAppApiError } from "./client";
import { UPLOAD_LIMITS, ALLOWED_MIME_TYPES } from "@/modules/media/storage";
import { uploadMedia } from "@/modules/media/service";
import type { Db } from "@/modules/customers/service";

const log = childLogger("channels.whatsapp.media");

/**
 * وسائط واتساب الواردة: ميتا بتبعت **معرّف** مش رابط، فالموظفة كانت تشوف
 * «وسيط» بلا محتوى. هالمهمة بتجيب رابط التحميل المؤقت بتوكن القناة، بتنزّل
 * البايتات، بتخزنها بمخزننا (نفس مسار رفع الوسائط ومعه فحوصه)، وبتحدّث
 * `Message.mediaUrl` لرابط عندنا.
 *
 * الفشل النهائي (نوع ممنوع · أكبر من الحد · وسيط محذوف) بينكتب سببه على
 * الرسالة وبيرجع نجاح — عشان ما يضل العامل يعيد مهمة ما بتنجح أبدًا.
 * الفشل المؤقت (ضغط · انقطاع · توكن منتهي مؤقتًا) بيرجع فشل حتى تنعاد.
 */
const SYSTEM_ACTOR = "system:whatsapp-media";

/** `audio/ogg; codecs=opus` (البصمة الصوتية بواتساب) ← `audio/ogg`. */
function baseMime(mimeType: string | null | undefined): string {
  return String(mimeType ?? "").split(";")[0]!.trim().toLowerCase();
}

function extFor(mime: string): string {
  return ALLOWED_MIME_TYPES[mime]?.ext ?? "bin";
}

export interface WhatsAppMediaJobPayload {
  workspaceId: string;
  channelId: string;
  /** wamid — الرسالة الي بدها الوسيط. */
  externalMessageId: string;
  mediaId: string;
  mimeType?: string | null;
  filename?: string | null;
}

/** سبب نهائي ينكتب على الرسالة بدل ما ينضيع بصمت. */
async function markFailed(
  db: Db,
  workspaceId: string,
  externalMessageId: string,
  reason: string
): Promise<void> {
  const msg = await db.message.findFirst({
    where: { workspaceId, externalMessageId },
    select: { id: true, metadata: true },
  });
  if (!msg) return;
  const metadata = (msg.metadata ?? {}) as Record<string, unknown>;
  await db.message.update({
    where: { id: msg.id },
    data: { metadata: { ...metadata, waMediaError: reason } },
  });
  log.warn({ workspaceId, externalMessageId, reason }, "whatsapp_media_failed");
}

export async function handleWhatsAppMediaDownload(
  db: Db,
  payload: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  const p = payload as unknown as WhatsAppMediaJobPayload;
  const workspaceId = String(p.workspaceId ?? "");
  const externalMessageId = String(p.externalMessageId ?? "");
  const mediaId = String(p.mediaId ?? "");
  if (!workspaceId || !externalMessageId || !mediaId) return { success: true };

  const message = await db.message.findFirst({
    where: { workspaceId, externalMessageId },
    select: { id: true, mediaUrl: true, metadata: true },
  });
  if (!message) {
    // الرسالة لسا ما انحفظت (ترتيب مهام) — إعادة بنفس المفتاح آمنة.
    return { success: false, error: "message not found yet" };
  }
  // عدم تكرار: الوسيط منزّل من قبل.
  if (message.mediaUrl) return { success: true };

  const channel = await db.channel.findFirst({
    where: { id: String(p.channelId ?? ""), workspaceId },
    select: { id: true },
  });
  if (!channel) {
    await markFailed(db, workspaceId, externalMessageId, "CHANNEL_NOT_FOUND");
    return { success: true };
  }
  const account = await db.channelAccount.findFirst({
    where: { channelId: channel.id },
    select: { encryptedCredentials: true },
  });
  if (!account?.encryptedCredentials) {
    await markFailed(db, workspaceId, externalMessageId, "CHANNEL_TOKEN_MISSING");
    return { success: true };
  }

  let token: string;
  try {
    token = decryptSecret(account.encryptedCredentials);
  } catch {
    await markFailed(db, workspaceId, externalMessageId, "CHANNEL_TOKEN_UNREADABLE");
    return { success: true };
  }

  const client = getWhatsAppClient();
  try {
    const meta = await client.getMediaMeta(token, mediaId);
    const mime = baseMime(meta.mimeType ?? p.mimeType);
    if (!ALLOWED_MIME_TYPES[mime]) {
      await markFailed(db, workspaceId, externalMessageId, `UNSUPPORTED_MEDIA_TYPE:${mime || "unknown"}`);
      return { success: true };
    }
    const limit = UPLOAD_LIMITS[ALLOWED_MIME_TYPES[mime]!.type];
    if (meta.fileSize !== null && meta.fileSize > limit) {
      await markFailed(db, workspaceId, externalMessageId, `MEDIA_TOO_LARGE:${meta.fileSize}`);
      return { success: true };
    }

    const { data } = await client.downloadMedia(token, meta.url, limit);
    const safeBase = String(p.filename ?? "")
      .replace(/[^\w.\-]+/g, "_")
      .slice(0, 64);
    const filename = safeBase && /\.[a-z0-9]{1,8}$/i.test(safeBase)
      ? safeBase
      : `wa-${mediaId.slice(0, 24)}.${extFor(mime)}`;

    const asset = await uploadMedia(db, { userId: SYSTEM_ACTOR, workspaceId }, {
      filename,
      mimeType: mime,
      size: data.byteLength,
      data,
      category: "OTHER",
      title: filename,
      description: "وسيط وارد من واتساب",
    });

    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    delete metadata.waMediaError;
    await db.message.update({
      where: { id: message.id },
      data: {
        mediaUrl: asset.url,
        metadata: { ...metadata, waMediaAssetId: asset.id, waMediaId: mediaId },
      },
    });
    log.info(
      { workspaceId, externalMessageId, mediaId, mime, size: data.byteLength, mediaAssetId: asset.id },
      "whatsapp_media_stored"
    );
    return { success: true };
  } catch (err) {
    if (err instanceof WhatsAppApiError && err.kind === "PERMANENT") {
      await markFailed(db, workspaceId, externalMessageId, `WA_${err.code ?? "PERMANENT"}`);
      return { success: true };
    }
    // فحوص الرفع (نوع · بايتات مشبوهة · مخزن) نهائية كمان — ما منعيدها.
    const code = (err as { code?: string })?.code;
    if (code === "UNSUPPORTED_MEDIA_TYPE" || code === "CORRUPT_FILE" || code === "STORAGE_WRITE_FAILED") {
      await markFailed(db, workspaceId, externalMessageId, code);
      return { success: true };
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ workspaceId, externalMessageId, mediaId, error: reason }, "whatsapp_media_retrying");
    return { success: false, error: reason };
  }
}
