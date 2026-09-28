import { childLogger } from "@/core/logger";
import type { FacebookClient } from "./client";
import type { Db } from "@/modules/customers/service";

const log = childLogger("facebook.profile");

/** Re-check cadence when Graph yields no name (avoids hammering per message). */
const NEGATIVE_CACHE_MS = 24 * 3600_000;

export interface SenderNameResult {
  /** Real profile name to persist, or null when unavailable. */
  name: string | null;
  /** Real profile picture URL to persist, or null when unavailable. */
  avatarUrl: string | null;
  /** True when the answer came from cache/throttle (no Graph call). */
  cached: boolean;
}

/**
 * Best-effort sender display-name resolution for one inbound PSID.
 *
 * Contract:
 * - Returns the REAL Facebook profile name or null — never a PSID, never a
 *   placeholder like "Facebook User", never a mock.
 * - Zero Graph calls in steady state: skipped when the identity already has
 *   a displayName, or when a negative check ran within NEGATIVE_CACHE_MS.
 * - Never throws; failures are logged with safe diagnostic fields only
 *   (httpStatus, Graph error code/message — no tokens, no secrets).
 * - The caller persists the name through the normal customer pipeline
 *   (processIncomingMessage backfill), so the UI always reads from DB and
 *   never waits on Graph.
 */
export async function resolveSenderName(
  db: Db,
  opts: { workspaceId: string; psid: string; pageToken: string | null; client: FacebookClient }
): Promise<SenderNameResult> {
  const { workspaceId, psid, pageToken, client } = opts;
  if (!psid || !pageToken) return { name: null, avatarUrl: null, cached: true };

  let identity: {
    id: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    metadata?: unknown;
  } | null = null;
  try {
    identity = await (db as any).channelIdentity.findFirst({
      where: { workspaceId, channelType: "FACEBOOK", channelExternalId: psid },
      select: { id: true, displayName: true, avatarUrl: true, metadata: true },
    });
  } catch {
    identity = null;
  }
  if (identity?.displayName && identity?.avatarUrl) return { name: null, avatarUrl: null, cached: true };

  const checkedAtRaw = (identity?.metadata as { profileCheckedAt?: string } | null)?.profileCheckedAt;
  const checkedAt = checkedAtRaw ? new Date(checkedAtRaw).getTime() : 0;
  if (checkedAt && Date.now() - checkedAt < NEGATIVE_CACHE_MS) {
    return { name: null, avatarUrl: null, cached: true };
  }

  let profile: Awaited<ReturnType<FacebookClient["getSenderProfile"]>>;
  try {
    profile = await client.getSenderProfile(pageToken, psid);
  } catch {
    profile = null;
  }

  // Record the check so failures don't retry on every message for 24h.
  if (identity) {
    try {
      const metadata = { ...((identity.metadata as Record<string, unknown>) ?? {}), profileCheckedAt: new Date().toISOString() };
      await (db as any).channelIdentity.update({ where: { id: identity.id }, data: { metadata } });
    } catch {
      // never break ingestion on bookkeeping
    }
  }

  if (!profile) {
    log.warn({ workspaceId, httpStatus: "network" }, "sender_profile_failed");
    return { name: null, avatarUrl: null, cached: false };
  }
  if (!profile.name && !profile.avatarUrl) {
    // Graph answered but gave no usable fields (or an explicit error) — log
    // WHY with safe fields only. Typical causes: token lacks scope, app in
    // dev mode for non-test users, or restricted profile.
    log.warn(
      { workspaceId, httpStatus: profile.httpStatus, graphCode: profile.errorCode, graphMessage: profile.errorMessage },
      "sender_profile_empty"
    );
    return { name: null, avatarUrl: null, cached: false };
  }
  log.info({ workspaceId, httpStatus: profile.httpStatus, nameObtained: Boolean(profile.name), avatarObtained: Boolean(profile.avatarUrl) }, "sender_profile_ok");
  return { name: profile.name, avatarUrl: profile.avatarUrl, cached: false };
}
