import { describe, expect, it } from "vitest";
import {
  hasPermission,
  hasAnyPermission,
  effectivePermissions,
  isPermission,
} from "@/modules/rbac/permissions";

describe("RBAC", () => {
  it("grants OWNER all permissions", () => {
    expect(hasPermission("OWNER", [], "workspace.manage")).toBe(true);
    expect(hasPermission("OWNER", [], "users.manage")).toBe(true);
  });

  it("denies VIEWER write permissions", () => {
    expect(hasPermission("VIEWER", [], "orders.write")).toBe(false);
    expect(hasPermission("VIEWER", [], "customers.write")).toBe(false);
    expect(hasPermission("VIEWER", [], "customers.read")).toBe(true);
  });

  it("does not grant SUPPORT_AGENT orders.write", () => {
    expect(hasPermission("SUPPORT_AGENT", [], "orders.write")).toBe(false);
    expect(hasPermission("SUPPORT_AGENT", [], "conversations.reply")).toBe(true);
  });

  // قرار المالك 2026-10-21 («الدعم امبلا بستلم»): موظف الدعم بيستلم التحويلات.
  // وبيرسل الرسائل كمان — مسار الرد (`/api/conversations/[id]/messages`) بيطلب
  // `channels.send_human`، فمن غيره بيستلم التحويل وما بيقدر يرد على الزبون.
  // الدليل الموثّق كان «مثل البيعي بدون orders.write» والمصفوفة كانت ناقصة.
  it("lets SUPPORT_AGENT receive handoffs and answer the customer", () => {
    for (const p of ["handoffs.read", "handoffs.claim", "handoffs.resolve", "channels.send_human"] as const) {
      expect(hasPermission("SUPPORT_AGENT", [], p), p).toBe(true);
    }
  });

  it("still keeps SUPPORT_AGENT away from order writes, discounts, approvals and management", () => {
    for (const p of [
      "orders.write",
      "orders.discount",
      "orders.discount.approve",
      "products.write",
      "products.wholesale",
      "campaigns.write",
      "campaigns.approve",
      "analytics.agents",
      "users.manage",
      "settings.manage",
      "workspace.manage",
    ] as const) {
      expect(hasPermission("SUPPORT_AGENT", [], p), p).toBe(false);
    }
  });

  it("applies member-level permission overrides", () => {
    expect(hasPermission("VIEWER", ["orders.write"], "orders.write")).toBe(true);
  });

  it("ignores unknown permission overrides", () => {
    expect(hasPermission("VIEWER", ["nonexistent.permission"], "orders.write")).toBe(false);
  });

  it("hasAnyPermission requires at least one match", () => {
    expect(hasAnyPermission("VIEWER", [], ["orders.write", "customers.read"])).toBe(true);
    expect(hasAnyPermission("VIEWER", [], ["orders.write", "users.manage"])).toBe(false);
  });

  it("unknown roles get no permissions", () => {
    expect(effectivePermissions("MYSTERY_ROLE", []).size).toBe(0);
  });

  it("validates permission names", () => {
    expect(isPermission("orders.read")).toBe(true);
    expect(isPermission("orders.delete")).toBe(false);
  });
});
