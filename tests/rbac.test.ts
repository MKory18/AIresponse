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
