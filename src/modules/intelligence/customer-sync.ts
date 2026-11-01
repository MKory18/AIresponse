import { childLogger } from "@/core/logger";
import { recordAudit } from "@/modules/audit/service";
import { normalizePhone } from "@/modules/orders/primitives";
import {
  type IntelFields,
  type IntelFieldMetaMap,
} from "./fields";

/**
 * P13 — مزامنة «معلومات العميل المستخرجة» إلى ملف العميل نفسه.
 *
 * النظام القائم (`customerIntel`) يحفظ المعلومات لكل محادثة مع مصدرها وحالتها
 * (EXTRACTED / CONFIRMED / CONFLICT). هذه الوحدة تنقل **الحقول المدعومة** فقط
 * إلى صف `Customer` بشكل آمن:
 *
 * - لا تُخترع قيمة: الحقول الفارغة تبقى فارغة.
 * - لا تُستبدل قيمة موجودة بقيمة مستخرجة عادية (المؤكد من موظف فقط يتقدّم).
 * - التعارض (CONFLICT) لا يُحسم آليًا — يُترك للمراجعة ولا يُكتب.
 * - عزل المساحة: كل قراءة/كتابة مقيّدة بـ workspaceId.
 * - idempotent: نفس اللقطة لا تُغيّر شيئًا عند إعادة التنفيذ.
 *
 * لا تُرسل شيئًا للعميل ولا تمسّ الرسائل أو الطلبات — كتابة ملف فقط.
 */

const log = childLogger("intelligence.customer-sync");

export interface CustomerProfileShape {
  name?: string | null;
  phone?: string | null;
  city?: string | null;
  address?: string | null;
  province?: string | null;
}

/** لقطة معلومات محادثة واحدة (كما تُقرأ من customerIntel). */
export interface IntelSnapshotRow {
  data: IntelFields | null | undefined;
  meta: IntelFieldMetaMap | null | undefined;
  updatedAt?: Date | string | null;
}

export interface CustomerSyncPlan {
  /** الحقول التي ستُكتب على العميل وقيمها. */
  set: Record<string, string>;
  /** الحقول التي لم تُكتب وسبب التخطي (للتشخيص فقط، بلا قيم). */
  skipped: Record<string, string>;
}

/** خريطة الحقول المدعومة: مفتاح معلومات العميل ← عمود صف العميل. */
const INTEL_TO_CUSTOMER: Array<{
  intelKey: string;
  customerField: keyof CustomerProfileShape;
  kind: "text" | "phone";
}> = [
  { intelKey: "customerName", customerField: "name", kind: "text" },
  { intelKey: "phone", customerField: "phone", kind: "phone" },
  { intelKey: "city", customerField: "city", kind: "text" },
  { intelKey: "address", customerField: "address", kind: "text" },
];

/** عمود ملف العميل المقابل لحقل الاستخراج (أو null إن لم يكن مدعومًا). */
export function customerFieldForIntelKey(intelKey: string): keyof CustomerProfileShape | null {
  return INTEL_TO_CUSTOMER.find((m) => m.intelKey === intelKey)?.customerField ?? null;
}

function asTime(v: Date | string | null | undefined): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") return new Date(v).getTime();
  return 0;
}

function nonEmpty(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

interface Candidate {
  value: string;
  confirmed: boolean;
  at: number;
}

/**
 * دالة نقية: تختار لكل حقل أفضل مرشّح من لقطات المحادثات، ثم تقرّر ما يُكتب
 * على ملف العميل مقابل ما يُترك.
 *
 * - المرشّح المؤكد (CONFIRMED من موظف) يتقدّم على المستخرج، ويتقدّم حتى على
 *   قيمة موجودة بالملف (سلطة الموظف).
 * - المستخرج العادي يملأ الفراغ فقط ولا يستبدل قيمة موجودة.
 * - حالة CONFLICT لا تُرشّح أبدًا.
 */
export function planCustomerSync(
  snapshots: IntelSnapshotRow[],
  customer: CustomerProfileShape
): CustomerSyncPlan {
  const set: Record<string, string> = {};
  const skipped: Record<string, string> = {};

  for (const map of INTEL_TO_CUSTOMER) {
    const field = map.customerField as string;
    const current = nonEmpty(customer[map.customerField]);
    let best: Candidate | null = null;

    for (const snap of snapshots) {
      const meta = snap.meta?.[map.intelKey];
      if (!meta) continue;
      if (meta.status === "CONFLICT") continue;
      const raw = snap.data?.[map.intelKey];
      let value = nonEmpty(raw);
      if (!value) continue;

      if (map.kind === "phone") {
        const norm = normalizePhone(value);
        if (!norm.valid || !norm.canonical) {
          // رقم غير صالح للحفظ — لا نخمّن.
          skipped[field] = "PHONE_INVALID";
          continue;
        }
        value = norm.canonical;
      }

      const confirmed = meta.status === "CONFIRMED";
      const at = asTime(snap.updatedAt);
      if (
        !best ||
        (confirmed && !best.confirmed) ||
        (confirmed === best.confirmed && at >= best.at)
      ) {
        best = { value, confirmed, at };
      }
    }

    if (!best) continue;
    if (current && !best.confirmed) {
      // قيمة موجودة بالملف لا تُمحى بقيمة مستخرجة عادية.
      skipped[field] = "EXISTING_KEPT";
      continue;
    }
    if (current && current === best.value) {
      skipped[field] = "UNCHANGED";
      continue;
    }
    set[field] = best.value;
  }

  return { set, skipped };
}

/**
 * يطبّق المزامنة على قاعدة البيانات: يقرأ لقطات كل محادثات العميل في مساحته،
 * يخطّط، ثم يكتب الحقول المسموحة فقط. فشل الكتابة لا يرمي أبدًا (يُسجّل) —
 * إلا في وضع `strict` (تصحيح موظف): عندها يرمي ليلغي المتصفح المعاملة كلها
 * (تحديث العميل + سجل التعديل) بدل صف محدّث بلا أثر.
 */
export async function syncIntelToCustomer(
  db: Record<string, any>,
  params: {
    workspaceId: string;
    customerId: string;
    /** P15 — الموظف المسؤول (يسجّل في تدقيق التصحيح). */
    actorUserId?: string | null;
    /** P15 — ارمِ عند الفشل بدل الابتلاع (داخل معاملة التصحيح). */
    strict?: boolean;
  }
): Promise<{ updated: string[]; skipped: Record<string, string> }> {
  const strict = Boolean(params.strict);
  try {
    const customer = await db.customer.findUnique({ where: { id: params.customerId } });
    if (!customer || customer.workspaceId !== params.workspaceId) {
      return { updated: [], skipped: {} };
    }
    const conversations = await db.conversation.findMany({
      where: { workspaceId: params.workspaceId, customerId: params.customerId },
      select: { id: true },
    });
    if (!conversations.length) return { updated: [], skipped: {} };

    const snapshots: IntelSnapshotRow[] = (
      await db.customerIntel.findMany({
        where: {
          workspaceId: params.workspaceId,
          conversationId: { in: conversations.map((c: { id: string }) => c.id) },
        },
        select: { data: true, fieldMeta: true, updatedAt: true },
      })
    ).map((s: { data: IntelFields | null; fieldMeta: IntelFieldMetaMap | null; updatedAt: Date | string | null }) => ({
      data: s.data,
      meta: s.fieldMeta,
      updatedAt: s.updatedAt,
    }));

    const plan = planCustomerSync(snapshots, customer);
    if (strict && plan.set.phone) {
      // داخل معاملة التصحيح: لا نُدخل معاملة ملغاة بسبب سباق فرادة الهاتف.
      // الفحص المسبق يترك الرقم على حاله ويُكمل باقي الحقول (السلوك القديم).
      const clash = await db.customer.findFirst({
        where: { workspaceId: params.workspaceId, phone: plan.set.phone, id: { not: params.customerId } },
        select: { id: true },
      });
      if (clash) {
        delete plan.set.phone;
        plan.skipped.phone = "PHONE_TAKEN";
      }
    }
    if (!Object.keys(plan.set).length) return { updated: [], skipped: plan.skipped };

    try {
      await db.customer.update({ where: { id: params.customerId }, data: plan.set });
    } catch (err) {
      if (strict) throw err;
      // سباق فرادة الهاتف (workspaceId+phone): نُسقط الهاتف ونعيد مرة واحدة.
      if ((err as { code?: string }).code === "P2002" && plan.set.phone) {
        const { phone, ...rest } = plan.set;
        plan.skipped.phone = "PHONE_TAKEN";
        if (Object.keys(rest).length) {
          await db.customer.update({ where: { id: params.customerId }, data: rest });
        }
        await recordAudit(db as never, {
          workspaceId: params.workspaceId,
          userId: params.actorUserId ?? null,
          action: "customer.intel_synced",
          entityType: "Customer",
          entityId: params.customerId,
          metadata: { fields: Object.keys(rest), phoneSkipped: true },
        });
        return { updated: Object.keys(rest), skipped: plan.skipped };
      }
      // سجل بالمعرّفات فقط — بلا قيمة أو بيانات عميل.
      log.warn(
        { customerId: params.customerId, workspaceId: params.workspaceId, code: (err as { code?: string }).code },
        "customer_intel_sync_failed"
      );
      return { updated: [], skipped: plan.skipped };
    }

    await recordAudit(db as never, {
      workspaceId: params.workspaceId,
      userId: params.actorUserId ?? null,
      action: "customer.intel_synced",
      entityType: "Customer",
      entityId: params.customerId,
      metadata: { fields: Object.keys(plan.set) },
    });
    return { updated: Object.keys(plan.set), skipped: plan.skipped };
  } catch (err) {
    if (strict) throw err;
    log.warn(
      { customerId: params.customerId, workspaceId: params.workspaceId },
      "customer_intel_sync_error"
    );
    void err;
    return { updated: [], skipped: {} };
  }
}
