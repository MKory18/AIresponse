import type { ConversationListItem, MessageItem } from "@/components/inbox/types";

/**
 * منطق صرف لشاشة المحادثات الجديدة (3.1) — بلا React، حتى ينختبر مباشرة.
 */

export type ViewTab = "all" | "attention" | "new";
export const VIEW_TABS: ReadonlyArray<{ key: ViewTab; label: string }> = [
  { key: "all", label: "الكل" },
  { key: "attention", label: "يحتاجك" },
  { key: "new", label: "جديدة" },
];

export interface Filters {
  status: "" | "OPEN" | "RESOLVED";
  channelId: string;
  assignee: "" | "me" | "none";
}
export const NO_FILTERS: Filters = { status: "", channelId: "", assignee: "" };

export function activeFilterCount(f: Filters): number {
  return [f.status, f.channelId, f.assignee].filter(Boolean).length;
}

/** مفتاح الاستعلام للخادم: «منتهية» = RESOLVED/CLOSED ما بتنعرض كحالتين (القاموس: مفتوحة · منتهية). */
export function listParams(opts: { view: ViewTab; q: string; filters: Filters; cursor?: string | null; ids?: string[] }): URLSearchParams {
  const p = new URLSearchParams({ limit: "30" });
  if (opts.view !== "all") p.set("view", opts.view);
  if (opts.q.trim()) p.set("q", opts.q.trim());
  if (opts.filters.status) p.set("status", opts.filters.status);
  if (opts.filters.channelId) p.set("channelId", opts.filters.channelId);
  if (opts.filters.assignee) p.set("assignee", opts.filters.assignee);
  if (opts.cursor) p.set("cursor", opts.cursor);
  if (opts.ids?.length) p.set("ids", opts.ids.join(","));
  return p;
}

/**
 * دمج تحديث حي للصفحة الأولى بالقائمة المحمّلة: **ما بيرجّع القائمة للصفحة الأولى ولا بيمسح اللي محمّل**
 * (عيب القديم: كل حدث حي كان يفضّي القائمة). المحادثات الجاية بتتقدّم، والقديمة اللي ما بالجديدة بتضل بعدها.
 */
export function mergeFirstPage(prev: readonly ConversationListItem[], fresh: readonly ConversationListItem[]): ConversationListItem[] {
  const seen = new Set(fresh.map((c) => c.id));
  return [...fresh, ...prev.filter((c) => !seen.has(c.id))];
}

/** إلحاق صفحة جديدة بلا تكرار. */
export function appendPage(prev: readonly ConversationListItem[], next: readonly ConversationListItem[]): ConversationListItem[] {
  const seen = new Set(prev.map((c) => c.id));
  return [...prev, ...next.filter((c) => !seen.has(c.id))];
}

/**
 * رسائل الخادم + الرسائل المحلية غير المؤكّدة (PENDING/QUEUED/FAILED): الاستطلاع ما بيمسحها قبل ما يشوف
 * المستخدم الفشل أو تنحل إعادة المحاولة.
 */
export function mergeMessages(server: readonly MessageItem[], local: readonly MessageItem[]): MessageItem[] {
  const pending = local.filter((m) => m.id.startsWith("optimistic-") && ["PENDING", "QUEUED", "FAILED"].includes(m.deliveryStatus));
  return [...server, ...pending];
}

/** مفتاح عدم التكرار لرسالة موظف (ضغطتين = نفس الصف). */
export function idempotencyKey(conversationId: string, now = Date.now(), rand = Math.random()): string {
  return `human-ui:${conversationId}:${now}:${rand.toString(36).slice(2, 8)}`;
}

/** من يرد: الوكيل أو الموظف (aiState ← مفتاح واحد). */
export function whoReplies(aiState: string | undefined): "agent" | "human" {
  return aiState === "HUMAN_ACTIVE" ? "human" : "agent";
}

/** هل بنود الانتباه الخاصة بالمحادثة؟ (عدّاد تبويب «يحتاجك»). */
export function attentionConversationCount(items: ReadonlyArray<{ href: string }>): number {
  return new Set(items.map((i) => /^\/conversations\?id=([^&]+)/.exec(i.href)?.[1]).filter(Boolean)).size;
}
