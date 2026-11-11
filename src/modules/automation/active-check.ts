import { childLogger } from "@/core/logger";

const log = childLogger("automation.active-check");

/**
 * Most workspaces have no enabled automations, yet every domain event used to
 * enqueue evaluation jobs that found nothing to do — several wasted jobs per
 * customer message, all competing with replies for the database.
 *
 * Cached briefly per workspace, so an automation enabled just now starts
 * receiving events within CACHE_MS. A failed check returns true: an extra no-op
 * job is cheap, a lost automation trigger is not.
 */
const CACHE_MS = 30_000;
const MAX_CACHED_WORKSPACES = 1000;
const cache = new Map<string, { at: number; enabled: boolean }>();

export async function workspaceHasEnabledAutomations(
  db: { automation?: { count(args: { where: { workspaceId: string; isEnabled: boolean } }): Promise<number> } },
  workspaceId: string
): Promise<boolean> {
  if (!db.automation) return true;
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.enabled;
  try {
    const enabled = (await db.automation.count({ where: { workspaceId, isEnabled: true } })) > 0;
    if (cache.size >= MAX_CACHED_WORKSPACES) cache.clear();
    cache.set(workspaceId, { at: Date.now(), enabled });
    return enabled;
  } catch (err) {
    log.warn({ err, workspaceId }, "automation_active_check_failed");
    return true;
  }
}
