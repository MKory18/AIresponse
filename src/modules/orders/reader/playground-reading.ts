import { NotFoundError } from "@/core/errors";
import type { Db } from "@/modules/jobs/service";
import { callReader, loadCatalog, type ReadJobDeps } from "./service";
import { shouldReadConversation, type FilterDecision } from "./filter";
import type { VerifiedReading } from "./verify";

/**
 * «شو قرأ النظام» بصفحة التجربة (3.5): بيشغّل القارئ على محادثة التجربة (داخلية، معزولة) بلا أي كتابة —
 * ولا طلب ولا مسودة ولا عميل. بنفس مسار القارئ الحقيقي (بوابة الخصوصية + التحقق من الكتالوج)، فالمالك بيشوف
 * بالضبط شو كان رح يطلع لو هاي المحادثة حقيقية.
 */

export interface PlaygroundReading {
  decision: FilterDecision;
  /** null = الفلتر قرّر إن المحادثة مش شبه طلب (ما انداس على القارئ). */
  reading: VerifiedReading | null;
}

type Row = Record<string, unknown>;
type M = Record<string, { findFirst: (a: unknown) => Promise<Row | null>; findMany: (a: unknown) => Promise<Row[]> }>;

export async function readPlaygroundSession(
  db: Db,
  input: { workspaceId: string; sessionId: string },
  deps: ReadJobDeps = {},
  now = new Date()
): Promise<PlaygroundReading> {
  const d = db as unknown as M;
  const session = (await d.playgroundSession.findFirst({
    where: { id: input.sessionId, workspaceId: input.workspaceId },
    select: { id: true, channelId: true },
  })) as { id: string; channelId?: string | null } | null;
  if (!session) throw new NotFoundError("Playground session");

  const rows = (await d.playgroundMessage.findMany({
    where: { sessionId: session.id, workspaceId: input.workspaceId },
    orderBy: [{ createdAt: "asc" }],
    take: 60,
    select: { id: true, role: true, text: true, createdAt: true },
  })) as Array<{ id: string; role: string; text: string; createdAt: Date }>;
  const messages = rows.map((m) => ({
    id: m.id,
    senderType: (m.role === "user" ? "CUSTOMER" : "AI") as "CUSTOMER" | "AI",
    type: "TEXT",
    text: m.text,
    createdAt: m.createdAt,
  }));

  const channel = session.channelId
    ? ((await d.channel.findFirst({ where: { id: session.channelId, workspaceId: input.workspaceId }, select: { id: true, name: true, market: true, orderRequiredFields: true } })) as {
        id: string;
        name?: string | null;
        market?: string | null;
        orderRequiredFields?: string[];
      } | null)
    : null;
  const products = await loadCatalog(db, input.workspaceId, channel?.id ?? null);
  const decision = shouldReadConversation({ messages, productNames: products.map((p) => p.name), hasOpenOrder: false });
  if (!decision.read) return { decision, reading: null };
  // customerId وهمي: ما في عميل بالتجربة (لا بيانات تُسحب من القاعدة).
  const { result } = await callReader(db, { workspaceId: input.workspaceId, customerId: "playground", channel, messages, products, deps, now });
  return { decision, reading: result.verified };
}
