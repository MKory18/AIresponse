import { createHandler } from "@/core/api/handler";
import { isEventForWorkspace, subscribeRealtime, type RealtimeEvent } from "@/modules/realtime/events";

/** SSE يحتاج Node streaming — ممنوع edge caching. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/events — بثّ لحظي للمساحة الحالية (SSE).
 *
 * - اتصال واحد لكل متصفح؛ مصادقة بالجلسة وفلترة صارمة بالمساحة.
 * - الحمولة معرّفات فقط (نوع الحدث + محادثة/كيان) — بلا أي نص أو بيانات عميل.
 * - heartbeat كل 15 ثانية يمنع قطع البروكسي.
 * - العميل عنده fallback polling إذا انقطع الاتصال.
 */
export const GET = createHandler(
  { permission: "conversations.read" },
  async ({ req, auth }) => {
    const workspaceId = auth!.workspaceId;
    const encoder = new TextEncoder();

    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          unsubscribe?.();
          unsubscribe = null;
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        send("ready", { ok: true });
        unsubscribe = subscribeRealtime((event: RealtimeEvent) => {
          // عزل المساحة: حدث مساحة تانية ما بيتسرّب أبدًا.
          if (!isEventForWorkspace(event, workspaceId)) return;
          send("change", {
            type: event.type,
            conversationId: event.conversationId ?? null,
            entityId: event.entityId ?? null,
            at: event.at,
          });
        });
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, HEARTBEAT_MS);

        req.signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe?.();
        unsubscribe = null;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
);
