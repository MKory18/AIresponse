import { buildToolDirectory } from "@/modules/agent-door/door";
import { doorJson, withAgentDoor } from "@/modules/agent-door/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * P12 — GET /api/agent/tools (agent-door/v1 §3): دليل أدوات الردود المسموحة
 * لهالتوكن بس — توكن hermes-bridge بيشوف قراءة ومسودة وبس.
 */
export const GET = withAgentDoor(async ({ db, token, requestId }) => {
  return doorJson(await buildToolDirectory(db, token), requestId);
});
