import type { Permission } from "@/modules/rbac/permissions";

/**
 * البحث الشامل (2.3، 03-UI-STRUCTURE §2): عميل بالاسم/الرقم · طلب برقمه أو باسم/رقم المستلم.
 * **بيرجّع بس اللي بيحق للطالب يشوفه** (`customers.read` / `orders.read`) — صفحات الموقع بتنبحث بالعميل (`nav-search.ts`).
 * مقيّد بالمساحة، وحد أدنى حرفين، ونتايج قليلة (الغرض قفز سريع مش تصفّح).
 */

export interface SearchHit {
  kind: "customer" | "order";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export interface SearchResult {
  customers: SearchHit[];
  orders: SearchHit[];
}

export const MIN_QUERY = 2;
export const MAX_QUERY = 64;
const PER_KIND = 5;

type Rows = Array<Record<string, unknown>>;
type Db = Record<string, { findMany(a: unknown): Promise<Rows> }>;
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** الأرقام العربية-الهندية ← لاتينية، ومسافات زيادة. */
export function normalizeSearchQuery(q: string): string {
  return q
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY);
}

export async function searchAll(dbIn: unknown, workspaceId: string, rawQuery: string, can: (p: Permission) => boolean): Promise<SearchResult> {
  const db = dbIn as Db;
  const q = normalizeSearchQuery(rawQuery);
  const out: SearchResult = { customers: [], orders: [] };
  if (q.length < MIN_QUERY) return out;
  const contains = { contains: q, mode: "insensitive" };

  if (can("customers.read")) {
    const rows = await db.customer!.findMany({
      where: { workspaceId, OR: [{ name: contains }, { phone: { contains: q } }] },
      orderBy: { lastContactAt: "desc" },
      take: PER_KIND,
    });
    out.customers = rows.map((c) => ({
      kind: "customer", id: s(c.id), title: s(c.name) || s(c.phone) || "عميل", subtitle: s(c.phone), href: `/customers/${s(c.id)}`,
    }));
  }
  if (can("orders.read")) {
    const rows = await db.order!.findMany({
      where: { workspaceId, OR: [{ orderNumber: contains }, { recipientName: contains }, { recipientPhone: { contains: q } }] },
      orderBy: { createdAt: "desc" },
      take: PER_KIND,
    });
    out.orders = rows.map((o) => ({
      kind: "order", id: s(o.id), title: s(o.orderNumber) || "طلب", subtitle: s(o.recipientName) || s(o.recipientPhone), href: `/orders?order=${s(o.id)}`,
    }));
  }
  return out;
}
