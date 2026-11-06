import { Client } from "pg";

/**
 * REALTIME — أحداث تغيير صغيرة عبر Postgres LISTEN/NOTIFY.
 *
 * - الحمولة **معرّفات ونوع فقط**: لا نصوص رسائل، لا أسماء، لا هواتف.
 * - النشر best-effort: فشله ما بيكسر أي عملية أعمال.
 * - المشترك (SSE) اتصال واحد لكل عملية ويب، وبيوزّع على كل عملاء SSE
 *   بالذاكرة — مش اتصال قاعدة لكل متصفح.
 * - القفل بالمساحة إلزامي عند البثّ.
 */

export const REALTIME_CHANNEL = "zaki_events";

export type RealtimeEventType =
  | "message.inbound"
  | "message.outbound"
  | "conversation.updated"
  | "order.created"
  | "order.telegram";

export interface RealtimeEvent {
  v: 1;
  workspaceId: string;
  type: RealtimeEventType;
  /** المحادثة المتأثرة (إن وُجدت). */
  conversationId?: string;
  /** كيان متأثر (رسالة/طلب) — معرّف فقط. */
  entityId?: string;
  at: string;
}

type RawExecutor = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/** يبني الحدث (حمولة بلا أي بيانات عميل — معرّفات فقط). */
export function buildRealtimeEvent(
  event: Omit<RealtimeEvent, "v" | "at"> & { at?: string }
): RealtimeEvent {
  return {
    v: 1,
    workspaceId: event.workspaceId,
    type: event.type,
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.entityId ? { entityId: event.entityId } : {}),
    at: event.at ?? new Date().toISOString(),
  };
}

/**
 * ينشر حدثًا. لا يرمي أبدًا: الـrealtime تحسين، مش شرط نجاح.
 * `db` مقبول كـPrisma أو أي كائن يدعم $executeRaw.
 */
export async function publishRealtime(
  db: unknown,
  event: Omit<RealtimeEvent, "v" | "at"> & { at?: string }
): Promise<void> {
  const payload = buildRealtimeEvent(event);
  const exec = (db as { $executeRaw?: RawExecutor["$executeRaw"] } | null)?.$executeRaw;
  if (typeof exec !== "function") return;
  try {
    await exec`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(payload)})`;
  } catch {
    // لا نكسر العمل لأن الإشعار اللحظي فشل.
  }
}

/** عزل المساحة — أي حدث مساحة تانية ما بيتسرّب. */
export function isEventForWorkspace(event: RealtimeEvent, workspaceId: string): boolean {
  return Boolean(workspaceId) && event.workspaceId === workspaceId;
}

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();
let client: Client | null = null;
let connecting: Promise<void> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;

function databaseUrl(): string | null {
  return process.env.DATABASE_URL?.trim() || null;
}

function fanout(raw: string) {
  let event: RealtimeEvent;
  try {
    event = JSON.parse(raw) as RealtimeEvent;
  } catch {
    return;
  }
  if (!event?.workspaceId) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // مستمع واحد فاشل ما يوقف الباقي.
    }
  }
}

function scheduleReconnect() {
  if (listeners.size === 0 || reconnectTimer) return;
  attempts = Math.min(attempts + 1, 6);
  const delay = Math.min(30_000, 500 * 2 ** attempts);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureListener();
  }, delay);
}

async function ensureListener(): Promise<void> {
  if (listeners.size === 0) return;
  if (client) return;
  if (connecting) return connecting;
  const url = databaseUrl();
  // لا اتصال بالاختبارات ولا بلا قاعدة — البثّ بيضل شغال بالذاكرة فقط.
  if (!url || process.env.VITEST || process.env.NODE_ENV === "test") return;

  connecting = (async () => {
    const next = new Client({ connectionString: url });
    next.on("notification", (msg) => {
      if (msg.channel === REALTIME_CHANNEL && msg.payload) fanout(msg.payload);
    });
    next.on("error", () => {
      // اتصال ميت: نعيد المحاولة بهدوء.
      try {
        void next.end().catch(() => undefined);
      } catch {
        // ignore
      }
      if (client === next) client = null;
      scheduleReconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${REALTIME_CHANNEL}`);
      client = next;
      attempts = 0;
    } catch {
      client = null;
      try {
        await next.end();
      } catch {
        // ignore
      }
      scheduleReconnect();
    }
  })().finally(() => {
    connecting = null;
  });

  return connecting;
}

/** يشترك بكل أحداث العملية الحالية (SSE). يرجّع دالة إلغاء. */
export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  void ensureListener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = client;
      client = null;
      if (current) void current.end().catch(() => undefined);
    }
  };
}

/** للاختبارات: عدد المستمعين الحاليين. */
export function realtimeListenerCount(): number {
  return listeners.size;
}
