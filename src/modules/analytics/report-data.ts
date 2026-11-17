/**
 * بيانات التقارير الخام (3.7، 05-DASHBOARDS §4): كل مؤشر بالكتالوج (`kpi-catalog.ts`) بيتحسب من هالشكل بدالة نقية —
 * يعني الواجهة والتصدير والاختبارات كلهم على نفس المعادلة. التحميل من القاعدة بـ`report-loader.ts`.
 */

export interface RptOrder {
  id: string;
  conversationId: string | null;
  status: string;
  total: number;
  currency: string;
  createdAt: Date;
  sealedAt: Date | null;
  omsOrderId: string | null;
  omsStatus: string | null;
  reviewReasons: string[];
}

export interface RptConversation {
  id: string;
  createdAt: Date;
  firstInboundAt: Date | null;
  firstOutboundAt: Date | null;
  /** `ConversationReading.firstOrderingAt` — أول مرة العميل بدّه يطلب فعلًا. */
  firstOrderingAt: Date | null;
}

export interface RptItem {
  orderId: string;
  productId: string;
  name: string;
  quantity: number;
  subtotal: number;
  currency: string;
}

export interface RptTeamRow {
  agentId: string;
  name: string;
  conversationsAssigned: number;
  repliesSent: number;
  firstResponseMedianMinutes: number | null;
  handoffsClaimed: number;
  handoffsResolved: number;
  ordersLinked: number;
  ordersLinkedConfirmed: number;
}

export interface ReportData {
  now: Date;
  start: Date;
  end: Date;
  timezone: string;
  /** طلبات مثبّتة بالفترة (`sealedAt` ضمنها؛ الطلبات القديمة قبل القارئ بتاريخ إنشائها). */
  sealed: RptOrder[];
  /** طلبات انخلقت بالفترة (أي حالة). */
  created: RptOrder[];
  /** كل طلبات محادثات الفترة (أي تاريخ) — القمع ونسبة التحويل على نفس المجموعة. */
  cohortOrders: RptOrder[];
  /** محادثات انفتحت بالفترة. */
  conversations: RptConversation[];
  /** بنود الطلبات المثبّتة بالفترة. */
  items: RptItem[];
  /** تعديلات: AMEND_REQUEST · CANCEL_REQUEST · STAFF_EDIT على الطلبات المثبّتة بالفترة. */
  revisions: Array<{ orderId: string; kind: string }>;
  /** اسم الصفحة لكل طلب مثبّت. */
  pageOfOrder: Record<string, string>;
  /** لحظي (مش حسب الفترة): آخر رسالة من العميل قبل > 10 دقايق وما انردّ عليها. */
  unansweredNow: number;
  /** محادثات استلمها موظف بالفترة. */
  takenOver: number;
  agentReplies: number;
  customerMessages: { needed: number; answered: number };
  failures: Array<{ error: string | null; status: string }>;
  aiPromises: number;
  cost: { knownUsd: number; unknownCalls: number; calls: number };
  /** من تاريخ الطلبات/المحادثات للرسمة الزمنية. */
  staffReplyTimes: Date[];
  agentReplyTimes: Date[];
  team: RptTeamRow[];
}

export function emptyReportData(start: Date, end: Date, timezone = "UTC", now: Date = new Date()): ReportData {
  return {
    now,
    start,
    end,
    timezone,
    sealed: [],
    created: [],
    cohortOrders: [],
    conversations: [],
    items: [],
    revisions: [],
    pageOfOrder: {},
    unansweredNow: 0,
    takenOver: 0,
    agentReplies: 0,
    customerMessages: { needed: 0, answered: 0 },
    failures: [],
    aiPromises: 0,
    cost: { knownUsd: 0, unknownCalls: 0, calls: 0 },
    staffReplyTimes: [],
    agentReplyTimes: [],
    team: [],
  };
}
