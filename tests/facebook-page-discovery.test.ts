/**
 * اكتشاف الصفحات + رقم إعداد الدخول من الموقع.
 *
 * ⚠️ تطبيق ميتا نوع Business (Facebook Login for Business): الموافقة بتخلص
 * والمالك بيختار صفحة، بس `/me/accounts` بيرجع فاضي — فالربط كان ينتهي بـ
 * `no_pages` والصفحة اللي وافق عليها ما بتظهر.
 * 🔧 إذا `/me/accounts` فاضي: منقرأ `granular_scopes` من `/debug_token` ومنجيب كل
 * صفحة بتوكن المستخدم. ورقم `config_id` بينقرأ من إعدادات المساحة أولًا وبعدها من البيئة.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/core/env";
import { FacebookClient } from "@/modules/channels/facebook/client";
import { buildAuthorizeUrl, resolveLoginConfigId } from "@/modules/channels/facebook/oauth";
import { getIntegrationSettings, updateIntegrationSettings } from "@/modules/integrations/settings";
import { createFakeDb } from "./helpers/inmemory-db";

const GRAPH = "https://graph.facebook.test/v21.0";
const USER_TOKEN = "USER_TOKEN_SECRET";

type Handler = (url: URL) => unknown;

function fakeFetch(routes: Record<string, Handler>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}`);
    const handler = routes[url.pathname];
    const body = handler ? handler(url) : { error: { message: "not found", code: 803 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("getUserPages — /me/accounts فاضي ← granular_scopes", () => {
  const before = { id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET };

  beforeEach(() => {
    process.env.META_APP_ID = "app-1";
    process.env.META_APP_SECRET = "secret-1";
    resetEnvCache();
  });

  afterEach(() => {
    for (const [k, v] of [["META_APP_ID", before.id], ["META_APP_SECRET", before.secret]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  });

  it("بيجيب الصفحات الممنوحة من debug_token بعد ما /me/accounts يرجع []", async () => {
    const calls: string[] = [];
    let debugInput: URL | null = null;
    const client = new FacebookClient({
      graphUrl: GRAPH,
      fetchImpl: fakeFetch(
        {
          "/v21.0/me/accounts": () => ({ data: [] }),
          "/v21.0/debug_token": (u) => {
            debugInput = u;
            return {
              data: {
                granular_scopes: [
                  { scope: "pages_show_list", target_ids: ["111", "222"] },
                  { scope: "pages_messaging", target_ids: ["111"] },
                  { scope: "pages_manage_metadata", target_ids: ["333"] },
                  { scope: "business_management", target_ids: ["999"] },
                ],
              },
            };
          },
          "/v21.0/111": () => ({ id: "111", name: "فيتا فارما", access_token: "PAGE_TOKEN_111" }),
          "/v21.0/222": () => ({ error: { message: "no access", code: 10 } }),
          "/v21.0/333": () => ({ id: "333", name: "صفحة ثانية", access_token: "PAGE_TOKEN_333" }),
        },
        calls
      ),
    });

    const pages = await client.getUserPages(USER_TOKEN);

    expect(pages).toEqual([
      { id: "111", name: "فيتا فارما", access_token: "PAGE_TOKEN_111" },
      { id: "333", name: "صفحة ثانية", access_token: "PAGE_TOKEN_333" },
    ]);
    // معرّفات مكررة بتنجلب مرة وحدة، وscope مش صفحات (business_management) بيتجاهل.
    expect(calls.filter((c) => c === "/v21.0/111")).toHaveLength(1);
    expect(calls).not.toContain("/v21.0/999");
    // debug_token: توكن المستخدم مدخل، وتوكن التطبيق APP_ID|APP_SECRET.
    expect(debugInput!.searchParams.get("input_token")).toBe(USER_TOKEN);
    expect(debugInput!.searchParams.get("access_token")).toBe("app-1|secret-1");
  });

  it("/me/accounts فيه صفحات: ما بيستدعي debug_token أبدًا", async () => {
    const calls: string[] = [];
    const client = new FacebookClient({
      graphUrl: GRAPH,
      fetchImpl: fakeFetch(
        { "/v21.0/me/accounts": () => ({ data: [{ id: "1", name: "A", access_token: "T1" }] }) },
        calls
      ),
    });
    expect(await client.getUserPages(USER_TOKEN)).toEqual([{ id: "1", name: "A", access_token: "T1" }]);
    expect(calls).toEqual(["/v21.0/me/accounts"]);
  });

  it("بيمشي ورا paging.next على مضيف Graph بس", async () => {
    const calls: string[] = [];
    const client = new FacebookClient({
      graphUrl: GRAPH,
      fetchImpl: fakeFetch(
        {
          "/v21.0/me/accounts": (u) =>
            u.searchParams.get("after")
              ? { data: [{ id: "2", name: "B", access_token: "T2" }] }
              : {
                  data: [{ id: "1", name: "A", access_token: "T1" }],
                  paging: { next: `${GRAPH}/me/accounts?after=c1&access_token=${USER_TOKEN}` },
                },
        },
        calls
      ),
    });
    const pages = await client.getUserPages(USER_TOKEN);
    expect(pages.map((p) => p.id)).toEqual(["1", "2"]);
  });

  it("ما بيتبع paging.next لمضيف غريب (التوكن بيفلت)", async () => {
    const calls: string[] = [];
    const client = new FacebookClient({
      graphUrl: GRAPH,
      fetchImpl: fakeFetch(
        {
          "/v21.0/me/accounts": () => ({
            data: [{ id: "1", name: "A", access_token: "T1" }],
            paging: { next: "https://evil.example.com/me/accounts?after=x" },
          }),
        },
        calls
      ),
    });
    expect((await client.getUserPages(USER_TOKEN)).map((p) => p.id)).toEqual(["1"]);
    expect(calls).toEqual(["/v21.0/me/accounts"]);
  });

  it("debug_token فشل = [] (بيضل no_pages بدل ما ينهار)", async () => {
    const client = new FacebookClient({
      graphUrl: GRAPH,
      fetchImpl: fakeFetch({
        "/v21.0/me/accounts": () => ({ data: [] }),
        "/v21.0/debug_token": () => ({ error: { message: "bad", code: 190 } }),
      }),
    });
    expect(await client.getUserPages(USER_TOKEN)).toEqual([]);
  });
});

describe("رقم config_id: إعداد المساحة (DB) بيغلب البيئة", () => {
  const before = process.env.META_LOGIN_CONFIG_ID;
  const REDIRECT = "https://staging.example.com/api/channels/facebook/callback";
  const cfg = (url: string) => new URLSearchParams(url.split("?")[1]).get("config_id");

  afterEach(() => {
    if (before === undefined) delete process.env.META_LOGIN_CONFIG_ID;
    else process.env.META_LOGIN_CONFIG_ID = before;
    resetEnvCache();
  });

  it("المصدر: workspace ثم env ثم none", () => {
    expect(resolveLoginConfigId("111111", "999999")).toEqual({ configId: "111111", source: "workspace" });
    expect(resolveLoginConfigId(null, "999999")).toEqual({ configId: "999999", source: "env" });
    expect(resolveLoginConfigId("  ", " 999999 ")).toEqual({ configId: "999999", source: "env" });
    expect(resolveLoginConfigId(undefined, "")).toEqual({ configId: null, source: "none" });
  });

  it("رابط الموافقة: قيمة DB بتغلب البيئة", () => {
    process.env.META_LOGIN_CONFIG_ID = "9999999999";
    resetEnvCache();
    expect(cfg(buildAuthorizeUrl("s", REDIRECT, "2372832796853310"))).toBe("2372832796853310");
  });

  it("بلا قيمة DB: البيئة احتياط · وبلاهم الاتنين: scope", () => {
    process.env.META_LOGIN_CONFIG_ID = "9999999999";
    resetEnvCache();
    expect(cfg(buildAuthorizeUrl("s", REDIRECT, null))).toBe("9999999999");
    delete process.env.META_LOGIN_CONFIG_ID;
    resetEnvCache();
    const url = buildAuthorizeUrl("s", REDIRECT, null);
    expect(cfg(url)).toBeNull();
    expect(new URLSearchParams(url.split("?")[1]).get("scope")).toContain("pages_show_list");
  });

  it("الرقم بينحفظ لكل مساحة بإعداداتها وبيرجع منها", async () => {
    const db = createFakeDb() as never;
    const ws = await (db as { workspace: { create: (a: unknown) => Promise<{ id: string }> } }).workspace.create({
      data: { name: "W", slug: "w" },
    });
    expect((await getIntegrationSettings(db, ws.id)).metaLoginConfigId).toBeNull();
    await updateIntegrationSettings(db, { workspaceId: ws.id, userId: "u1" }, { metaLoginConfigId: "2372832796853310" });
    expect((await getIntegrationSettings(db, ws.id)).metaLoginConfigId).toBe("2372832796853310");
    await expect(
      updateIntegrationSettings(db, { workspaceId: ws.id, userId: "u1" }, { metaLoginConfigId: "abc" })
    ).rejects.toThrow();
  });
});
