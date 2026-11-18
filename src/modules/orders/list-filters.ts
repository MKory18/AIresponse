import type { Prisma } from "@prisma/client";
import type { OrderTab } from "@/lib/order-status";

/**
 * فلاتر قائمة الطلبات من الخادم (3.2): التبويبات هي الفلتر، **وعدّاداتها من الخادم** (مش من أول 25 صف محمّلين —
 * كانت العدّادات الخمسة القديمة بتنحسب من الصفوف المحمّلة بس). نفس تعريف `orderMatchesTab` بالضبط (`tests/orders-list-filters`).
 */

const SEALED_STATUSES = ["CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"];

export function tabWhere(tab: OrderTab | undefined): Prisma.OrderWhereInput {
  switch (tab) {
    case "review":
      return { status: "CONFIRMATION_PENDING" };
    case "awaiting":
      return { status: "NEW" };
    case "sealed":
      return { OR: [{ sealedAt: { not: null } }, { status: { in: SEALED_STATUSES as never } }] };
    case "cancelled":
      return { status: { in: ["CANCELLED", "FAILED"] } };
    default:
      return {};
  }
}

/** بحث: رقم الطلب · اسم/رقم المستلم · اسم/رقم العميل. حد أدنى حرفين؛ الأرقام الهندية بتتحوّل للاتينية. */
export function searchWhere(q: string | undefined): Prisma.OrderWhereInput {
  const text = (q ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  if (text.length < 2) return {};
  const contains = { contains: text, mode: "insensitive" as const };
  return {
    OR: [
      { orderNumber: contains },
      { recipientName: contains },
      { recipientPhone: { contains: text } },
      { customer: { name: contains } },
      { customer: { phone: { contains: text } } },
    ],
  };
}

type CountDb = { order: { count(a: unknown): Promise<number> } };

export const ORDER_TAB_KEYS: OrderTab[] = ["all", "review", "awaiting", "sealed", "cancelled"];

/** عدّاد كل تبويب (كامل، مش من صفحة محمّلة). */
export async function ordersCounts(db: unknown, workspaceId: string): Promise<Record<OrderTab, number>> {
  const d = db as CountDb;
  const entries = await Promise.all(ORDER_TAB_KEYS.map(async (tab) => [tab, await d.order.count({ where: { workspaceId, ...tabWhere(tab) } })] as const));
  return Object.fromEntries(entries) as Record<OrderTab, number>;
}
