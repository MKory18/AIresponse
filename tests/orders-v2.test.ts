import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findForbiddenTerms } from "@/lib/glossary";
import { ORDER_TABS } from "@/lib/order-status";
import { Drawer } from "@/components/ui/drawer";
import { ORDERS_STRINGS } from "@/app/(dashboard)/orders/v2/strings";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

/** 3.2ب — «الطلبات» الجديدة: تبويبات بعدّادات الخادم · جدول بعدد كلي · درج بنفس بطاقة الطلب · مفتاح الواجهة. */
const read = (p: string) => readFileSync(p, "utf8");
const DIR = join(process.cwd(), "src", "app", "(dashboard)", "orders", "v2");

describe("Drawer", () => {
  const html = (open: boolean) => renderToStaticMarkup(createElement(Drawer, { open, onClose: () => {}, title: "الطلب SY-1", footer: createElement("b", null, "تذييل") }, createElement("p", null, "محتوى")));
  it("مغلق = ما بيرسم شي", () => expect(html(false)).toBe(""));
  it("مفتوح: dialog معنون بـaria-modal، وزر إغلاق بـaria-label، وتذييل ومحتوى", () => {
    const out = html(true);
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-label="الطلب SY-1"');
    expect(out).toContain('aria-label="إغلاق"');
    expect(out).toContain("تذييل");
    expect(out).toContain("محتوى");
  });
  it("ملء الشاشة بالجوال وعرض 480 بغيره", () => {
    const out = html(true);
    expect(out).toContain("w-full");
    expect(out).toContain("sm:w-[480px]");
  });
});

describe("صفحة /orders", () => {
  it("الصفحة بتعرض الجدول الجديد بس (القديمة انحذفت بـ3.8)", () => {
    const p = read("src/app/(dashboard)/orders/page.tsx");
    expect(p).toContain("<OrdersView />");
    expect(p).not.toContain("resolveUiVersion");
    expect(p).not.toContain("LegacyOrders");
  });

  it("التبويبات من الخادم بعدّاداتها، وبحث، وعدد كلي، وحمّل المزيد", () => {
    const hook = read(join(DIR, "use-orders.ts"));
    expect(hook).toContain("/api/orders/counts");
    expect(hook).toContain('p.set("tab"');
    expect(hook).toContain('p.set("q"');
    expect(hook).toContain("cursor");
    const view = read(join(DIR, "orders-view.tsx"));
    for (const t of ORDER_TABS) expect(ORDER_TABS.map((x) => x.key)).toContain(t.key);
    expect(view).toContain("counts[t.key]");
    expect(view).toContain("total={total}");
    expect(view).toContain("onLoadMore");
  });

  it("الدرج: نفس بطاقة الطلب + وضع الـOMS + رابط المحادثة، ورابط دائم ?order=", () => {
    const d = read(join(DIR, "order-drawer.tsx"));
    expect(d).toContain("<OrderCard");
    expect(d).toContain("<OmsOrderCard");
    expect(d).toContain("/api/conversations/${conversationId}/order-card");
    const v = read(join(DIR, "orders-view.tsx"));
    expect(v).toContain('params.get("order")');
    expect(v).toContain('next.set("order"');
    // رابط دائم لطلب خارج الصفحة المحمّلة: بنجيبه لحاله
    expect(v).toContain("/api/orders/${openId}");
  });

  it("عمود حالة وحدة من orderStatusLabel، ولا أزرار طباعة/فلتر حالات التأكيد", () => {
    const v = read(join(DIR, "orders-view.tsx"));
    expect(v).toContain("orderStatusLabel");
    expect(v).not.toMatch(/confirmationStatus|طباعة/);
    expect(Object.keys(ORDERS_STRINGS.columns)).toEqual(["order", "customer", "items", "total", "status", "updated"]);
  });

  it("القاموس: ولا كلمة ممنوعة، ولا ملف فوق 300 سطر", () => {
    for (const f of readdirSync(DIR)) {
      const code = read(join(DIR, f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(findForbiddenTerms(code).map((x) => x.word), f).toEqual([]);
      expect(code.split("\n").length, f).toBeLessThanOrEqual(300);
    }
  });
});
