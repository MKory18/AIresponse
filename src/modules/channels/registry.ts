import type { ChannelType } from "@prisma/client";
import { FacebookChannelAdapter, type FacebookAdapterContext } from "./facebook/adapter";
import { InstagramChannelAdapter, type InstagramAdapterContext } from "./instagram/adapter";
import { TelegramChannelAdapter, type TelegramAdapterContext } from "./telegram/adapter";
import { WhatsAppChannelAdapter, type WhatsAppAdapterContext } from "./whatsapp/adapter";
import { TikTokChannelAdapter, type TikTokAdapterContext } from "./tiktok/adapter";
import { MockChannelAdapter } from "./mock-adapter";
import { ChannelNotSupportedError, type ChannelAdapter } from "./types";

// Re-exported so existing import paths keep working.
export { ChannelNotSupportedError };

export interface AdapterContext {
  /**
   * Explicit test/dev opt-in for the mock. The mock is NEVER a silent
   * fallback: production resolution without a registered real adapter
   * throws ChannelNotSupportedError.
   */
  mock?: boolean;
  /** Page binding for the real Facebook adapter. */
  facebook?: FacebookAdapterContext;
  /** Account binding for the real Instagram adapter. */
  instagram?: InstagramAdapterContext;
  /** Bot binding for the real Telegram adapter. */
  telegram?: TelegramAdapterContext;
  /** Number binding for the real WhatsApp adapter. */
  whatsapp?: WhatsAppAdapterContext;
  /** Account binding for the local-only TikTok adapter. */
  tiktok?: TikTokAdapterContext;
}

type AdapterFactory = (ctx: AdapterContext) => ChannelAdapter;

const defaultFactories = new Map<ChannelType, AdapterFactory>([
  [
    "FACEBOOK",
    (ctx) => {
      if (!ctx.facebook) {
        throw new ChannelNotSupportedError("FACEBOOK (missing page binding)");
      }
      return new FacebookChannelAdapter(ctx.facebook);
    },
  ],
  [
    "INSTAGRAM",
    (ctx) => {
      if (!ctx.instagram) {
        throw new ChannelNotSupportedError("INSTAGRAM (missing account binding)");
      }
      return new InstagramChannelAdapter(ctx.instagram);
    },
  ],
  [
    "TELEGRAM",
    (ctx) => {
      if (!ctx.telegram) {
        throw new ChannelNotSupportedError("TELEGRAM (missing bot binding)");
      }
      return new TelegramChannelAdapter(ctx.telegram);
    },
  ],
  [
    "WHATSAPP",
    (ctx) => {
      if (!ctx.whatsapp) {
        throw new ChannelNotSupportedError("WHATSAPP (missing number binding)");
      }
      return new WhatsAppChannelAdapter(ctx.whatsapp);
    },
  ],
  [
    "TIKTOK",
    (ctx) => {
      if (!ctx.tiktok) {
        throw new ChannelNotSupportedError("TIKTOK (missing account binding)");
      }
      return new TikTokChannelAdapter(ctx.tiktok);
    },
  ],
]);

const factories = new Map<ChannelType, AdapterFactory>(defaultFactories);

/** Test/dev override for a channel factory (null restores the default). */
export function setChannelAdapterFactory(type: ChannelType, factory: AdapterFactory | null): void {
  if (factory) factories.set(type, factory);
  else {
    factories.delete(type);
    const def = defaultFactories.get(type);
    if (def) factories.set(type, def);
  }
}

/**
 * Resolves the adapter for a channel (P5: multi-channel registry).
 * FACEBOOK/INSTAGRAM/TELEGRAM/WHATSAPP bind production adapters;
 * TIKTOK binds the local-only adapter; anything without a registered real
 * adapter throws instead of silently returning a mock.
 *
 * Live flows resolve through here: Meta webhook + ChannelSender (P1.1),
 * Instagram/Telegram/WhatsApp/TikTok ingest + sends (P5).
 */
export function getChannelAdapter(channelType: ChannelType, ctx: AdapterContext = {}): ChannelAdapter {
  if (ctx.mock) return new MockChannelAdapter(channelType);
  const factory = factories.get(channelType);
  if (!factory) throw new ChannelNotSupportedError(channelType);
  return factory(ctx);
}
