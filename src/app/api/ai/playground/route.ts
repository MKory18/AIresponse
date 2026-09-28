import { createHandler } from "@/core/api/handler";

/**
 * The legacy single-shot console wrote transient rows into the PRODUCTION
 * Message table (provider:"playground"), polluting the real inbox. It is
 * retired in favor of the isolated sessions API below, which persists only
 * to PlaygroundSession/PlaygroundMessage and never touches production
 * data or the Facebook sender.
 *
 *   POST /api/ai/playground/sessions
 *   POST /api/ai/playground/sessions/[id]/messages
 */
export const POST = createHandler({ permission: "ai.configure" }, async () => {
  return Response.json(
    {
      error: "GONE",
      message: "استخدم جلسات التجربة الجديدة: POST /api/ai/playground/sessions",
    },
    { status: 410 }
  );
});
