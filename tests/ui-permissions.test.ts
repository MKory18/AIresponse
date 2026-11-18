import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Can, PermissionsProvider } from "@/components/auth/permissions";

/**
 * 2.2 — الواجهة بتعرف صلاحيات العضو: `<Can>` بيخفي اللي ما بيقدر عليه (تحسين تجربة بس؛ الـAPI هو الحكم).
 */
const render = (permissions: string[] | null, el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(permissions ? createElement(PermissionsProvider, { permissions }, el) : el);

describe("<Can> / PermissionsProvider", () => {
  const btn = createElement("button", null, "احذف");

  it("بيعرض الأبناء لمن يملك الصلاحية", () => {
    expect(render(["orders.delete"], createElement(Can, { permission: "orders.delete" }, btn))).toContain("احذف");
  });

  it("بيخفيهم لمن لا يملكها، وبيعرض fallback إن وُجد", () => {
    expect(render(["orders.read"], createElement(Can, { permission: "orders.delete" }, btn))).not.toContain("احذف");
    expect(
      render(["orders.read"], createElement(Can, { permission: "orders.delete", fallback: createElement("i", null, "مقفول") }, btn))
    ).toContain("مقفول");
  });

  it("anyOf: واحدة تكفي", () => {
    expect(render(["orders.write"], createElement(Can, { anyOf: ["orders.delete", "orders.write"] }, btn))).toContain("احذف");
  });

  it("بلا مزوّد: مقفول (الأمان قبل الراحة)", () => {
    expect(render(null, createElement(Can, { permission: "orders.read" }, btn))).not.toContain("احذف");
  });
});

describe("الـlayout بيغلّف الصفحات بالمزوّد و/api/auth/me بيرجّع الصلاحيات", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("layout", () => expect(read("src/app/(dashboard)/layout.tsx")).toContain("PermissionsProvider"));
  it("me", () => {
    const me = read("src/app/api/auth/me/route.ts");
    expect(me).toContain("permissions");
    expect(me).toContain("isSuperAdmin");
    expect(me).toContain("role");
  });
});
