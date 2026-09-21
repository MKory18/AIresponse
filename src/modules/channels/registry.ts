import type { ChannelType } from "@prisma/client";
import type { ChannelAdapter } from "./types";
import { MockChannelAdapter } from "./mock-adapter";

/**
 * Resolves the adapter for a channel. Real Meta/WhatsApp/Telegram adapters are
 * registered here in Phase 6; MockChannelAdapter keeps the pipeline runnable
 * in development and tests.
 */
export function getChannelAdapter(channelType: ChannelType): ChannelAdapter {
  return new MockChannelAdapter(channelType);
}
