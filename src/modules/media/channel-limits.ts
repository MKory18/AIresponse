/**
 * WHAT EACH CHANNEL CAN CARRY — ONE TABLE, READ BEFORE ANY SEND.
 *
 * The library accepts whatever the STORAGE allows (10MB images, webp/gif,
 * 100MB video). The channels accept less, and a file the channel refuses
 * fails the whole reply unless the sender skips it first. Every outbound
 * path with an attachment consults this table through `mediaFitsChannel`
 * and records the skip reason instead of failing the text with the image.
 *
 * WhatsApp numbers are the platform's documented media limits. Messenger
 * and Instagram go through Meta's Send API, whose attachment cap is 25MB;
 * only formats this integration actually emits (image/video/audio/file —
 * see outbound.ts `attachType`) are listed, so no format is assumed
 * without the code that sends it. Other channels are not judged here —
 * they keep today's pass-through rather than gaining a new refusal.
 */

export type ChannelMediaKind = "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";

interface ChannelRule {
  mimes: string[];
  maxBytes: number;
}

const RULES: Record<string, Partial<Record<ChannelMediaKind, ChannelRule>>> = {
  WHATSAPP: {
    IMAGE: { mimes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024 },
    VIDEO: { mimes: ["video/mp4", "video/3gpp", "video/3gpp2"], maxBytes: 16 * 1024 * 1024 },
  },
  FACEBOOK: {
    IMAGE: { mimes: ["image/jpeg", "image/png", "image/gif"], maxBytes: 25 * 1024 * 1024 },
    VIDEO: { mimes: ["video/mp4"], maxBytes: 25 * 1024 * 1024 },
    AUDIO: { mimes: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 25 * 1024 * 1024 },
  },
  INSTAGRAM: {
    IMAGE: { mimes: ["image/jpeg", "image/png", "image/gif"], maxBytes: 25 * 1024 * 1024 },
    VIDEO: { mimes: ["video/mp4"], maxBytes: 25 * 1024 * 1024 },
    AUDIO: { mimes: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 25 * 1024 * 1024 },
  },
};

export type MediaFit = { ok: true } | { ok: false; reason: "UNSUPPORTED_TYPE" | "TOO_LARGE" };

export function mediaFitsChannel(
  asset: { type: string; mimeType: string; size: number },
  channelType: string
): MediaFit {
  const table = RULES[channelType];
  // No table, no new refusal: channels outside this table keep today's
  // pass-through behaviour.
  if (!table) return { ok: true };
  const rule = table[asset.type as ChannelMediaKind];
  if (!rule || !rule.mimes.includes(asset.mimeType)) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  if (asset.size > rule.maxBytes) return { ok: false, reason: "TOO_LARGE" };
  return { ok: true };
}

/** The short Arabic line the library shows for an unsuitable file. */
export function whatsappUnsuitableReason(asset: { type: string; mimeType: string; size: number }): string | null {
  const fit = mediaFitsChannel(asset, "WHATSAPP");
  if (fit.ok) return null;
  return fit.reason === "TOO_LARGE" ? "TOO_LARGE" : "UNSUPPORTED_TYPE";
}
