/**
 * الحزمة 3.7 — كتالوج المؤشرات (05-DASHBOARDS §4) وإصلاحات الاحتساب (§6): كل بند اتكتب اختباره قبل الإصلاح.
 *  L-08 جمع العملات · L-16 نسبة التحويل · L-17 القمع · L-20 زمن الرد بلا ردّ · L-21 زمن الحل · L-23 قبول العروض.
 * (L-18 اليوم الحي و L-19 منطقة المساحة الزمنية: `analytics-reports.test.ts` على قاعدة بالذاكرة.)
 */
import { describe, expect, it } from "vitest";
import { findForbiddenTerms } from "@/lib/glossary";
import { emptyReportData, type ReportData, type RptConversation, type RptOrder } from "@/modules/analytics/report-data";
import { KPI_CATALOG, computeKpi, funnelStages, kpiByKey, omsOutcome } from "@/modules/analytics/kpi-catalog";

const T0 = new Date("2026-11-10T00:00:00Z");
const T1 = new Date("2026-11-17T00:00:00Z");
const NOW = new Date("2026-11-17T12:00:00Z");
const min = (m: number, from = T0) => new Date(from.getTime() + m * 60_000);

function order(o: Partial<RptOrder> & { id: string }): RptOrder {
  return { conversationId: null, status: "CONFIRMED", total: 10, currency: "USD", createdAt: min(10), sealedAt: min(20), omsOrderId: null, omsStatus: null, reviewReasons: [], ...o };
}
function conv(c: Partial<RptConversation> & { id: string }): RptConversation {
  return { createdAt: min(5), firstInboundAt: min(5), firstOutboundAt: null, firstOrderingAt: null, ...c };
}
function data(over: Partial<ReportData> = {}): ReportData {
  return { ...emptyReportData(T0, T1, "UTC", NOW), ...over };
}
const val = (key: string, d: ReportData) => computeKpi(kpiByKey(key)!, d);

describe("الكتالوج: كل مؤشر معه معادلته", () => {
  it("مفاتيح فريدة، وكل مؤشر له اسم ومعادلة عربية", () => {
    const keys = KPI_CATALOG.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of KPI_CATALOG) {
      expect(k.label.length, k.key).toBeGreaterThan(1);
      expect(k.formula.length, k.key).toBeGreaterThan(10);
      expect(/[؀-ۿ]/.test(k.formula), k.key).toBe(true);
    }
  });
  it("لا كلمة ممنوعة بالأسماء ولا بالمعادلات", () => {
    const text = KPI_CATALOG.map((k) => `${k.label} ${k.formula}`).join(" ");
    expect(findForbiddenTerms(text).map((x) => x.word)).toEqual([]);
  });
  it("L-21: ما في مؤشر «زمن الحل» · L-23: ولا «قبول العروض» (مخفي مع ميزة العروض)", () => {
    const text = KPI_CATALOG.map((k) => `${k.key} ${k.label}`).join(" ").toLowerCase();
    expect(text).not.toContain("resolution");
    expect(text).not.toContain("offer");
    expect(text).not.toContain("زمن الحل");
    expect(text).not.toContain("قبول العرض");
  });
  it("كل تبويب فيه مؤشرات، والفريق بصلاحيته والكلفة بصلاحيتها", () => {
    for (const tab of ["sales", "conversations", "agent", "team"] as const) expect(KPI_CATALOG.some((k) => k.tab === tab), tab).toBe(true);
    expect(kpiByKey("team.agents")!.permission).toBe("analytics.agents");
    expect(kpiByKey("agent.cost")!.permission).toBe("usage.read");
  });
});

describe("L-08: المبالغ لكل عملة لحالها", () => {
  it("دولار وليرة = سطرين، مش مجموع", () => {
    const d = data({ sealed: [order({ id: "a", total: 20, currency: "USD" }), order({ id: "b", total: 150000, currency: "SYP" }), order({ id: "c", total: 5, currency: "USD" })] });
    const v = val("sales.value", d);
    expect(v.kind).toBe("money");
    if (v.kind !== "money") return;
    expect(v.value).toEqual([
      { currency: "SYP", value: 150000 },
      { currency: "USD", value: 25 },
    ]);
  });
  it("متوسط قيمة الطلب لكل عملة (القيمة ÷ عدد طلبات نفس العملة)", () => {
    const d = data({ sealed: [order({ id: "a", total: 20 }), order({ id: "b", total: 10 }), order({ id: "c", total: 300, currency: "SYP" })] });
    const v = val("sales.avg_value", d);
    if (v.kind !== "money") throw new Error("money");
    expect(v.value).toEqual([
      { currency: "SYP", value: 300 },
      { currency: "USD", value: 15 },
    ]);
  });
  it("الجمع بالسنتات: ما في انجراف فاصلة عائمة", () => {
    const d = data({ sealed: [order({ id: "a", total: 0.1 }), order({ id: "b", total: 0.2 })] });
    const v = val("sales.value", d);
    if (v.kind !== "money") throw new Error("money");
    expect(v.value).toEqual([{ currency: "USD", value: 0.3 }]);
  });
  it("بلا طلبات = قائمة فاضية (مش صفر مزوّر)", () => {
    const v = val("sales.value", data());
    if (v.kind !== "money") throw new Error("money");
    expect(v.value).toEqual([]);
  });
});

describe("L-16: نسبة التحويل على نفس مجموعة المحادثات", () => {
  it("محادثات فتحت بالفترة وإلها طلب مثبّت ÷ محادثات الفترة", () => {
    const d = data({
      conversations: [conv({ id: "c1" }), conv({ id: "c2" }), conv({ id: "c3" }), conv({ id: "c4" })],
      cohortOrders: [order({ id: "o1", conversationId: "c1" }), order({ id: "o2", conversationId: "c1" }), order({ id: "o3", conversationId: "c2", sealedAt: null, status: "NEW" })],
    });
    const v = val("sales.conversion", d);
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.num).toBe(1); // c1 بس (محادثة وحدة حتى لو إلها طلبين)
    expect(v.den).toBe(4);
    expect(v.value).toBeCloseTo(25);
  });
  it("طلبات الفترة لمحادثات أقدم ما بتنفخ النسبة (الحالة اللي كانت تطلع 150%)", () => {
    const d = data({
      conversations: [conv({ id: "c1" })],
      sealed: [order({ id: "o1", conversationId: "old1" }), order({ id: "o2", conversationId: "old2" }), order({ id: "o3", conversationId: "c1" })],
      cohortOrders: [order({ id: "o3", conversationId: "c1" })],
    });
    const v = val("sales.conversion", d);
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.value).toBe(100);
  });
  it("خاصية: النسبة ما بتتخطى 100% وكل مرحلة بالقمع ≤ اللي قبلها، بأي بيانات", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const STATUS = ["NEW", "CONFIRMATION_PENDING", "CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "RETURNED"];
    for (let run = 0; run < 300; run++) {
      const n = Math.floor(rnd() * 12);
      const conversations = Array.from({ length: n }, (_, i) => conv({ id: `c${i}`, firstOrderingAt: rnd() < 0.5 ? min(7) : null }));
      const cohortOrders: RptOrder[] = [];
      const orders = Math.floor(rnd() * 25);
      for (let i = 0; i < orders; i++) {
        const sealed = rnd() < 0.6;
        cohortOrders.push(
          order({
            id: `o${i}`,
            conversationId: rnd() < 0.9 ? `c${Math.floor(rnd() * (n + 3))}` : null, // ممكن محادثة خارج المجموعة
            status: STATUS[Math.floor(rnd() * STATUS.length)]!,
            sealedAt: sealed ? min(30) : null,
            omsOrderId: rnd() < 0.5 ? "x" : null,
            omsStatus: ["CONFIRMED", "REJECTED", "NEW", null][Math.floor(rnd() * 4)] ?? null,
          })
        );
      }
      const d = data({ conversations, cohortOrders });
      const v = val("sales.conversion", d);
      if (v.kind !== "percent") throw new Error("percent");
      if (v.value !== null) {
        expect(v.value).toBeGreaterThanOrEqual(0);
        expect(v.value).toBeLessThanOrEqual(100);
      }
      const stages = funnelStages(d);
      for (let i = 1; i < stages.length; i++) expect(stages[i]!.count, `run ${run} stage ${i}`).toBeLessThanOrEqual(stages[i - 1]!.count);
      expect(stages[0]!.count).toBe(n);
    }
  });
});

describe("L-17: القمع من firstOrderingAt والطلبات (المسودات خارج الحساب)", () => {
  it("6 مراحل على نفس المجموعة، ونسبة كل مرحلة من اللي قبلها", () => {
    const d = data({
      conversations: [
        conv({ id: "c1", firstOrderingAt: min(8) }), // نية فقط
        conv({ id: "c2", firstOrderingAt: min(8) }), // طلب لسا ما انثبت
        conv({ id: "c3", firstOrderingAt: min(8) }), // مثبّت
        conv({ id: "c4", firstOrderingAt: min(8) }), // أكّده الـ OMS
        conv({ id: "c5", firstOrderingAt: min(8) }), // تسلّم
        conv({ id: "c6" }), // سؤال بس
      ],
      cohortOrders: [
        order({ id: "o2", conversationId: "c2", status: "NEW", sealedAt: null }),
        order({ id: "o3", conversationId: "c3", omsOrderId: "x", omsStatus: "NEW" }),
        order({ id: "o4", conversationId: "c4", omsOrderId: "x", omsStatus: "CONFIRMED" }),
        order({ id: "o5", conversationId: "c5", status: "DELIVERED", omsOrderId: "x", omsStatus: "DELIVERED" }),
      ],
    });
    const s = funnelStages(d);
    expect(s.map((x) => x.count)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(s.map((x) => x.key)).toEqual(["new", "intent", "ordered", "sealed", "oms_confirmed", "delivered"]);
    expect(s[1]!.rateFromPrev).toBeCloseTo(5 / 6);
    expect(s[0]!.rateFromPrev).toBeNull();
  });
  it("طلب بلا قراءة (طلبات قديمة) بيعدّ نية — القمع ما بينكسر", () => {
    const d = data({ conversations: [conv({ id: "c1" })], cohortOrders: [order({ id: "o", conversationId: "c1" })] });
    const s = funnelStages(d);
    expect(s[1]!.count).toBe(1);
    expect(s[2]!.count).toBe(1);
  });
  it("حالة الطلب الحالية ما بتشيل المحادثة من مراحلها (ألغي بعد التثبيت = لسا مثبّت)", () => {
    const d = data({ conversations: [conv({ id: "c1" })], cohortOrders: [order({ id: "o", conversationId: "c1", status: "CANCELLED" })] });
    expect(funnelStages(d)[3]!.count).toBe(1);
  });
});

describe("نتيجة الـ OMS", () => {
  it("مؤكد · مرفوض · عند فريق التأكيد · ما انبعت", () => {
    expect(omsOutcome(order({ id: "a", omsOrderId: "x", omsStatus: "CONFIRMED" }))).toBe("confirmed");
    expect(omsOutcome(order({ id: "a", omsOrderId: "x", omsStatus: "REJECTED" }))).toBe("rejected");
    expect(omsOutcome(order({ id: "a", omsOrderId: "x", omsStatus: "CANCELED" }))).toBe("rejected");
    expect(omsOutcome(order({ id: "a", omsOrderId: "x", omsStatus: "IN_PROGRESS" }))).toBe("pending");
    expect(omsOutcome(order({ id: "a", omsOrderId: "x", omsStatus: "NEW", status: "DELIVERED" }))).toBe("confirmed");
    expect(omsOutcome(order({ id: "a" }))).toBe("unsent");
  });
  it("نسبة التأكيد = مؤكد ÷ (مؤكد + مرفوض) والمعلّق جنبها عدد مش بالنسبة", () => {
    const d = data({
      sealed: [
        order({ id: "a", omsOrderId: "x", omsStatus: "CONFIRMED" }),
        order({ id: "b", omsOrderId: "x", omsStatus: "CONFIRMED" }),
        order({ id: "c", omsOrderId: "x", omsStatus: "REJECTED" }),
        order({ id: "d", omsOrderId: "x", omsStatus: "IN_PROGRESS" }),
        order({ id: "e" }),
      ],
    });
    const v = val("sales.oms_confirm", d);
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.num).toBe(2);
    expect(v.den).toBe(3);
    expect(v.note).toContain("1");
  });
});

describe("نسبة التسليم · التعديل بعد التثبيت · التراجع قبل التثبيت", () => {
  it("التسليم = مسلّمة ÷ (مسلّمة + مرتجعة)، وبالطريق عدد جنبها", () => {
    const d = data({ sealed: [order({ id: "a", status: "DELIVERED" }), order({ id: "b", status: "DELIVERED" }), order({ id: "c", status: "RETURNED" }), order({ id: "d", status: "OUT_FOR_DELIVERY" })] });
    const v = val("sales.delivery_rate", d);
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.num).toBe(2);
    expect(v.den).toBe(3);
    expect(v.note).toContain("1");
  });
  it("التعديل بعد التثبيت = طلبات مثبّتة إلها طلب تعديل/إلغاء ÷ المثبّتة (طلب بتعديلين = مرة)", () => {
    const d = data({
      sealed: [order({ id: "a" }), order({ id: "b" }), order({ id: "c" }), order({ id: "d" })],
      revisions: [
        { orderId: "a", kind: "AMEND_REQUEST" },
        { orderId: "a", kind: "CANCEL_REQUEST" },
        { orderId: "b", kind: "STAFF_EDIT" },
      ],
    });
    const v = val("sales.amend_rate", d);
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.num).toBe(1);
    expect(v.den).toBe(4);
  });
  it("التراجع قبل التثبيت = ملغاة وهي بلا تثبيت ÷ كل المنخلقة بالفترة", () => {
    const d = data({
      created: [order({ id: "a", status: "CANCELLED", sealedAt: null }), order({ id: "b", status: "CANCELLED" }), order({ id: "c", status: "NEW", sealedAt: null }), order({ id: "d" })],
    });
    const v = val("sales.pre_seal_cancel", d);
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.num).toBe(1);
    expect(v.den).toBe(4);
  });
  it("مقام صفر = «غير متاح» (null) مش 0%", () => {
    for (const key of ["sales.conversion", "sales.oms_confirm", "sales.delivery_rate", "sales.amend_rate", "sales.pre_seal_cancel"]) {
      const v = val(key, data());
      if (v.kind !== "percent") throw new Error("percent");
      expect(v.value, key).toBeNull();
    }
  });
});

describe("L-20: زمن أول رد ما بيتجاهل اللي ما انردّ عليهم", () => {
  it("بلا رد لأكتر من 10 دقايق بيدخل الوسيط بزمن الانتظار الفعلي (ما بينشال)", () => {
    const now = min(120);
    const d = data({
      now,
      conversations: [
        conv({ id: "a", firstInboundAt: min(0), firstOutboundAt: min(1) }), // دقيقة
        conv({ id: "b", firstInboundAt: min(0), firstOutboundAt: min(2) }), // دقيقتين
        conv({ id: "c", firstInboundAt: min(0), firstOutboundAt: null }), // ساعتين بلا رد
      ],
    });
    const v = val("conversations.first_reply", d);
    if (v.kind !== "minutes") throw new Error("minutes");
    expect(v.value).toBe(2); // وسيط {1,2,120}
    const onlyAnswered = data({ now, conversations: d.conversations.slice(0, 2) });
    const w = val("conversations.first_reply", onlyAnswered);
    if (w.kind !== "minutes") throw new Error("minutes");
    expect(w.value).toBe(1.5);
    expect(v.note).toContain("1"); // بلا رد: 1
  });
  it("نفس العدد مع أغلبية بلا رد: الوسيط بيطلع الانتظار الطويل مش رقم جميل", () => {
    const now = min(300);
    const d = data({
      now,
      conversations: [
        conv({ id: "a", firstInboundAt: min(0), firstOutboundAt: min(1) }),
        conv({ id: "b", firstInboundAt: min(0), firstOutboundAt: null }),
        conv({ id: "c", firstInboundAt: min(0), firstOutboundAt: null }),
      ],
    });
    const v = val("conversations.first_reply", d);
    if (v.kind !== "minutes") throw new Error("minutes");
    expect(v.value).toBe(300);
  });
  it("بلا رد أقل من 10 دقايق لسا بمهلتها (مش محسوبة)", () => {
    const now = min(5);
    const d = data({ now, conversations: [conv({ id: "a", firstInboundAt: min(0), firstOutboundAt: null })] });
    const v = val("conversations.first_reply", d);
    if (v.kind !== "minutes") throw new Error("minutes");
    expect(v.value).toBeNull();
  });
  it("محادثة بلا رسالة عميل أصلًا بتنتخطّى", () => {
    const d = data({ conversations: [conv({ id: "a", firstInboundAt: null })] });
    const v = val("conversations.first_reply", d);
    if (v.kind !== "minutes") throw new Error("minutes");
    expect(v.value).toBeNull();
  });
});

describe("مؤشرات الوكيل", () => {
  it("نجاح الرد = ردود ÷ رسائل كان لازم يرد عليها", () => {
    const v = val("agent.reply_success", data({ customerMessages: { needed: 10, answered: 9 } }));
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.value).toBe(90);
  });
  it("دقة القراءة = مثبّتة بلا تعديل موظف وبلا سبب مراجعة ÷ المثبّتة", () => {
    const d = data({
      sealed: [order({ id: "a" }), order({ id: "b", reviewReasons: ["PHONE_INVALID"] }), order({ id: "c" }), order({ id: "d" })],
      revisions: [{ orderId: "c", kind: "STAFF_EDIT" }],
    });
    const v = val("agent.read_accuracy", d);
    if (v.kind !== "percent") throw new Error("percent");
    expect(v.num).toBe(2);
    expect(v.den).toBe(4);
  });
  it("وعد بلا طلب = عدد، والمطلوب صفر", () => {
    const v = val("agent.ai_promise", data({ aiPromises: 3 }));
    expect(v).toEqual({ kind: "count", value: 3 });
  });
  it("الكلفة: المعروف + «N نداء بلا سعر» (ما بنعرض مجموع ناقص كأنه كامل)", () => {
    const v = val("agent.cost", data({ cost: { knownUsd: 1.5, unknownCalls: 4, calls: 10 } }));
    if (v.kind !== "money") throw new Error("money");
    expect(v.value).toEqual([{ currency: "USD", value: 1.5 }]);
    expect(v.note).toContain("4");
    const none = val("agent.cost", data({ cost: { knownUsd: 0, unknownCalls: 5, calls: 5 } }));
    expect(none.kind).toBe("unavailable");
  });
  it("أسباب الفشل بالعربي مع رابط الحل، وبلا نص خام ولا بيانات", () => {
    const d = data({
      failures: [
        { error: "Request timed out after 30s", status: "FAILED" },
        { error: "401 Unauthorized: invalid api key sk-abc123", status: "FAILED" },
        { error: "insufficient_quota", status: "FAILED" },
        { error: "503 Service Unavailable", status: "FAILED" },
        { error: "blocked by guardrail UNCONFIRMED_ORDER_CLAIM", status: "BLOCKED" },
        { error: "weird 0791234567", status: "FAILED" },
      ],
    });
    const v = val("agent.failures", d);
    if (v.kind !== "rows") throw new Error("rows");
    const byReason = Object.fromEntries(v.rows.map((r) => [r.reason, r.count]));
    expect(byReason["مهلة"]).toBe(1);
    expect(byReason["مفتاح أو رصيد"]).toBe(2);
    expect(byReason["المزوّد واقع"]).toBe(1);
    expect(byReason["رفض الحارس"]).toBe(1);
    expect(byReason["غير مصنّف"]).toBe(1);
    expect(JSON.stringify(v)).not.toContain("sk-abc");
    expect(JSON.stringify(v)).not.toContain("0791234567");
    expect(v.rows.every((r) => typeof r.fix === "string" && String(r.href).startsWith("/"))).toBe(true);
  });
});

describe("أكثر المنتجات وحسب الصفحة (لكل عملة)", () => {
  it("بنود الطلبات المثبّتة: كمية وقيمة السطور، وكل عملة بصف", () => {
    const d = data({
      items: [
        { orderId: "a", productId: "p1", name: "قميص", quantity: 2, subtotal: 20, currency: "USD" },
        { orderId: "b", productId: "p1", name: "قميص", quantity: 1, subtotal: 10, currency: "USD" },
        { orderId: "c", productId: "p1", name: "قميص", quantity: 1, subtotal: 150000, currency: "SYP" },
        { orderId: "d", productId: "p2", name: "حذاء", quantity: 1, subtotal: 50, currency: "USD" },
      ],
    });
    const v = val("sales.top_products", d);
    if (v.kind !== "rows") throw new Error("rows");
    expect(v.rows[0]).toMatchObject({ product: "قميص", currency: "USD", quantity: 3, value: 30 });
    expect(v.rows.some((r) => r.currency === "SYP" && r.value === 150000)).toBe(true);
    expect(v.rows).toHaveLength(3);
  });
});
