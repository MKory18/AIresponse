/**
 * الحزمة 3.6 — «الصفحات والقنوات»: بطاقة لكل صفحة بـ4 إعدادات · سوق القناة (PATCH) · إعادة الربط للتوكن المنتهي ·
 * بطاقتا الـ OMS وتيليجرام انتقلتا · المطلوب لكل صفحة انتقل لقواعد الطلب · قيود الكود.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { findForbiddenTerms } from "@/lib/glossary";
import { listChannels } from "@/modules/channels/connect";
import { PermissionsProvider } from "@/components/auth/permissions";
import { ToastProvider } from "@/components/ui/toast";
import { CONNECT_TYPES, MARKETS, SEND_MODES, connectBody, connectionChip, needsReconnect, type ChannelRow } from "@/app/(dashboard)/channels/v2/model";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never),
}));
import { ChannelCard } from "@/app/(dashboard)/channels/v2/channel-card";

type Db = Prisma.TransactionClient;
const read = (p: string) => readFileSync(p, "utf8");

const row = (o: Partial<ChannelRow> = {}): ChannelRow => ({
  id: "ch1", type: "FACEBOOK", status: "CONNECTED", displayName: "صفحة المتجر", externalId: "123", aiPersonaId: null, sendMode: "AUTO_REPLY",
  market: null, catalog: { id: "cat1", name: "كل المنتجات", isActive: true }, hasAccount: true, tokenStatus: "LONG_LIVED",
  connectedAt: "2026-11-01T10:00:00Z", lastWebhookAt: "2026-11-17T10:00:00Z", lastSendAt: null, ...o,
});

describe("model: الاتصال وإعادة الربط", () => {
  it("شارة الاتصال بنص ونبرة؛ التوكن المنتهي يغلب", () => {
    expect(connectionChip({ status: "CONNECTED", tokenStatus: "VALID" })).toEqual({ text: "مربوطة", tone: "success" });
    expect(connectionChip({ status: "CONNECTED", tokenStatus: "EXPIRED" })).toEqual({ text: "التوكن منتهي", tone: "danger" });
    expect(connectionChip({ status: "ERROR", tokenStatus: "VALID" }).tone).toBe("danger");
    expect(connectionChip({ status: "DISCONNECTED", tokenStatus: "LONG_LIVED" }).tone).toBe("neutral");
    expect(connectionChip({ status: "CONNECTING", tokenStatus: "LONG_LIVED" }).tone).toBe("info");
  });
  it("«أعد الربط»: توكن منتهي أو خطأ أو مفصولة وإلها حساب سابق — مش المربوطة السليمة ولا المفصولة بلا حساب", () => {
    expect(needsReconnect({ status: "CONNECTED", tokenStatus: "EXPIRED", hasAccount: true })).toBe(true);
    expect(needsReconnect({ status: "ERROR", tokenStatus: "VALID", hasAccount: true })).toBe(true);
    expect(needsReconnect({ status: "DISCONNECTED", tokenStatus: "VALID", hasAccount: true })).toBe(true);
    expect(needsReconnect({ status: "DISCONNECTED", tokenStatus: "VALID", hasAccount: false })).toBe(false);
    expect(needsReconnect({ status: "CONNECTED", tokenStatus: "LONG_LIVED", hasAccount: true })).toBe(false);
  });
  it("جسم الربط حسب القناة، وخيارات الوضع والسوق الصحيحة", () => {
    const f = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(connectBody("INSTAGRAM", f({ igId: " 9 ", token: "EAA" }))).toEqual({ igId: "9", token: "EAA" });
    expect(connectBody("TELEGRAM", f({ botToken: "1:A" }))).toEqual({ botToken: "1:A" });
    expect(connectBody("WHATSAPP", f({ phoneNumberId: "5", token: "T" }))).toEqual({ phoneNumberId: "5", token: "T" });
    expect(CONNECT_TYPES).toEqual(["INSTAGRAM", "TELEGRAM", "WHATSAPP"]);
    expect(SEND_MODES.map((m) => m.value)).toEqual(["AUTO_REPLY", "COLLECTION_ONLY"]);
    expect(MARKETS.map((m) => m.value)).toEqual(["SY", "JO", ""]);
  });
});

describe("الخادم: listChannels", () => {
  it("بيرجّع السوق والمجموعة ونبض التوكن (VALID · EXPIRED · LONG_LIVED) والتواريخ", async () => {
    const soon = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const db = {
      channel: {
        findMany: async () => [
          { id: "a", type: "FACEBOOK", status: "CONNECTED", displayName: "A", externalId: "1", aiPersonaId: null, sendMode: "AUTO_REPLY", market: "SY", updatedAt: new Date(), catalogAssignment: { catalog: { id: "c1", name: "مجموعة", isActive: true } } },
          { id: "b", type: "TELEGRAM", status: "CONNECTED", displayName: "B", externalId: "2", aiPersonaId: null, sendMode: "AUTO_REPLY", updatedAt: new Date(), catalogAssignment: null },
          { id: "c", type: "FACEBOOK", status: "CONNECTED", displayName: "C", externalId: "3", aiPersonaId: null, sendMode: "AUTO_REPLY", market: "JO", updatedAt: new Date(), catalogAssignment: null },
        ],
      },
      channelAccount: {
        findMany: async () => [
          { channelId: "a", tokenExpiresAt: soon, lastWebhookAt: null, lastSendAt: null, connectedAt: new Date("2026-11-01") },
          { channelId: "c", tokenExpiresAt: past, lastWebhookAt: null, lastSendAt: null },
          { channelId: "b", tokenExpiresAt: null, lastWebhookAt: null, lastSendAt: null },
        ],
      },
    };
    const out = await listChannels(db as unknown as Db, "ws");
    const by = Object.fromEntries(out.map((c) => [c.id, c]));
    expect(by.a).toMatchObject({ market: "SY", tokenStatus: "VALID", catalog: { id: "c1", name: "مجموعة" } });
    expect(by.b).toMatchObject({ market: null, tokenStatus: "LONG_LIVED", catalog: null });
    expect(by.c).toMatchObject({ market: "JO", tokenStatus: "EXPIRED" });
    expect("catalogAssignment" in by.a!).toBe(false);
  });
});

describe("المسارات والصفحات", () => {
  it("PATCH /api/channels/by-id/[id]: السوق SY/JO/null بصلاحية channels.connect، ومساحة تانية 404، وبتدقيق", () => {
    const r = read("src/app/api/channels/by-id/[id]/route.ts");
    expect(r).toContain('z.enum(["SY", "JO"]).nullable()');
    expect(r).toContain('permission: "channels.connect"');
    expect(r).toContain("channel.workspaceId !== auth!.workspaceId");
    expect(r).toContain('"channel.market_changed"');
    expect(r).not.toMatch(/export const (?!PATCH)/);
  });
  it("/channels بتعرض الشاشة الجديدة، وبطاقتا الـ OMS وتيليجرام ما بقوا فيها وصاروا بمكان مشترك", () => {
    const p = read("src/app/(dashboard)/channels/page.tsx");
    expect(p).toContain("<ChannelsView />");
    for (const f of ["oms-section", "telegram-order-section", "order-fields-section", "multi-channel-section", "catalog-page-section"]) {
      expect(existsSync(join("src/app/(dashboard)/channels", `${f}.tsx`)), f).toBe(false);
    }
    const integ = read("src/app/(dashboard)/settings/integrations/page.tsx");
    expect(integ).toContain("@/components/integrations/oms-section");
    expect(integ).toContain("@/components/integrations/telegram-order-section");
    expect(existsSync("src/components/integrations/oms-section.tsx")).toBe(true);
  });
  it("«المطلوب لكل صفحة» انتقل لقواعد الطلب بنفس القسم", () => {
    expect(read("src/app/(dashboard)/assistant/order-rules/page.tsx")).toContain("<PageRequiredFields />");
    expect(read("src/components/orders/page-required-fields.tsx")).toContain("<OrderFieldsSection channelId={c.id} />");
  });
});

describe("البطاقة", () => {
  const html = (r: ChannelRow, perms: string[] = ["channels.connect"]) =>
    renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(
          PermissionsProvider,
          { permissions: perms },
          createElement(ChannelCard, { row: r, personas: [{ id: "p1", name: "ودودة" }], catalogs: [{ id: "cat1", name: "كل المنتجات" }], onSave: async () => null, onReconnect: () => {}, onDisconnect: () => {}, onTest: () => {} })
        )
      )
    );

  it("الإعدادات الأربعة بس + التفاصيل التقنية مطوية", () => {
    const h = html(row());
    for (const label of ["الوضع", "الشخصية", "مجموعة المنتجات", "السوق"]) expect(h, label).toContain(label);
    expect(h).toContain("رد آلي");
    expect(h).toContain("قراءة فقط");
    expect(h).toContain("سوريا");
    expect(h).toContain("الأردن");
    expect(h).toContain("<details");
    expect(h).toContain("تفاصيل تقنية");
    expect(h).not.toContain("أعد الربط");
  });
  it("توكن منتهي ← «أعد الربط» (فيسبوك = رابط OAuth)", () => {
    const h = html(row({ tokenStatus: "EXPIRED" }));
    expect(h).toContain("أعد الربط");
    expect(h).toContain('href="/api/channels/facebook/connect"');
    expect(h).toContain("التوكن منتهي");
  });
  it("بلا مجموعة منتجات = تنبيه أحمر + الحل (قاعدة المالك)", () => {
    const h = html(row({ catalog: null }));
    expect(h).toContain("بلا مجموعة منتجات");
    expect(h).toContain('data-callout="risk"');
    expect(h).toContain('data-callout="fix"');
  });
  it("بلا صلاحية channels.connect: ما في إعدادات قابلة للتعديل ولا أزرار ربط", () => {
    const h = html(row({ tokenStatus: "EXPIRED" }), ["channels.read"]);
    expect(h).toContain("ما عندك صلاحية تغيير إعدادات القنوات");
    expect(h).not.toContain("أعد الربط");
    expect(h).not.toContain("<select");
    expect(h).not.toContain("تفاصيل تقنية");
  });
});

describe("قيود الكود", () => {
  const DIR = join(process.cwd(), "src", "app", "(dashboard)", "channels", "v2");
  it("ولا كلمة ممنوعة ولا ملف فوق 300 سطر", () => {
    for (const f of readdirSync(DIR)) {
      const code = read(join(DIR, f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(findForbiddenTerms(code).map((x) => x.word), f).toEqual([]);
      expect(code.split("\n").length, f).toBeLessThanOrEqual(300);
    }
  });
});
