import { childLogger } from "@/core/logger";
import type { FacebookClient } from "./client";
import type { Db } from "@/modules/customers/service";

const log = childLogger("facebook.profile");

/** Re-check cadence when Graph yields no name (avoids hammering per message). */
const NEGATIVE_CACHE_MS = 24 * 3600_000;
/**
 * Re-check cadence when the Graph request itself failed (network/timeout).
 * A network failure is transient — retrying after 15 minutes restores the
 * real name/avatar quickly instead of staying hidden for a full day.
 */
const NETWORK_NEGATIVE_CACHE_MS = 15 * 60_000;
/**
 * Refresh cadence for KNOWN profiles: even when name+avatar are stored, re-fetch
 * at most once per week so FB renames/picture changes converge — without
 * slowing any single message (best-effort, cached, 4s-bounded).
 */
const STALE_REFRESH_MS = 7 * 24 * 3600_000;

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
  const started = Date.now();
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
  const meta = (identity?.metadata as { profileCheckedAt?: string; profileNetworkFailAt?: string } | null) ?? {};
  const checkedAtRaw = meta.profileCheckedAt;
  const checkedAt = checkedAtRaw ? new Date(checkedAtRaw).getTime() : 0;
  const checkedAgeMs = checkedAt ? Date.now() - checkedAt : Infinity;
  const networkFailAt = meta.profileNetworkFailAt ? new Date(meta.profileNetworkFailAt).getTime() : 0;
  const networkFailAgeMs = networkFailAt ? Date.now() - networkFailAt : Infinity;
  const hasFullProfile = Boolean(identity?.displayName && identity?.avatarUrl);
  // Skip Graph when: (a) full profile + refreshed within 7d, (b) definitive
  // Graph check within 24h, or (c) a NETWORK failure within 15min. The short
  // network window restores real names fast after transient outages instead
  // of hiding them for a day.
  if (
    (hasFullProfile && checkedAgeMs < STALE_REFRESH_MS) ||
    checkedAgeMs < NEGATIVE_CACHE_MS ||
    networkFailAgeMs < NETWORK_NEGATIVE_CACHE_MS
  ) {
    return { name: null, avatarUrl: null, cached: true };
  }

  // getSenderProfile never throws: null means the request itself failed
  // (network/timeout), while a Graph error/empty answer comes back as an
  // object with null fields. Only the network case uses the short retry.
  const profile = await client.getSenderProfile(pageToken, psid).catch(() => null);
  const networkFailed = profile === null;
  const durationMs = Date.now() - started;
  void durationMs;

  // Record the check so failures don't retry on every message. A definitive
  // Graph outcome is throttled for 24h; a network failure only for 15min.
  if (identity) {
    try {
      const metadata: Record<string, unknown> = { ...meta };
      if (networkFailed) {
        metadata.profileNetworkFailAt = new Date().toISOString();
      } else {
        metadata.profileCheckedAt = new Date().toISOString();
      }
      await (db as any).channelIdentity.update({ where: { id: identity.id }, data: { metadata } });
    } catch {
      // never break ingestion on bookkeeping
    }
  }

  // Emit structured observability for all outcomes (safe fields only).
  log.info(
    { workspaceId, cached: false, durationMs: Date.now() - started },
    "profile_fetch_started"
  );
  if (!profile) {
    log.warn({ workspaceId, httpStatus: "network", durationMs: Date.now() - started }, "sender_profile_failed");
    log.warn({ workspaceId, status: "failed", durationMs: Date.now() - started }, "profile_fetch_failed");
    return { name: null, avatarUrl: null, cached: false };
  }
  if (!profile.name && !profile.avatarUrl) {
    // Graph answered but gave no usable fields (or an explicit error) — log
    // WHY with safe fields only. Typical causes: token lacks scope, app in
    // dev mode for non-test users, or restricted profile.
    log.warn(
      { workspaceId, httpStatus: profile.httpStatus, graphCode: profile.errorCode, graphMessage: profile.errorMessage, durationMs: Date.now() - started },
      "sender_profile_empty"
    );
    log.warn({ workspaceId, status: "empty", durationMs: Date.now() - started }, "profile_fetch_failed");
    return { name: null, avatarUrl: null, cached: false };
  }
  log.info({ workspaceId, httpStatus: profile.httpStatus, nameObtained: Boolean(profile.name), avatarObtained: Boolean(profile.avatarUrl), durationMs: Date.now() - started }, "sender_profile_ok");
  log.info({ workspaceId, status: "completed", durationMs: Date.now() - started }, "profile_fetch_completed");
  return { name: profile.name, avatarUrl: profile.avatarUrl, cached: false };
}
