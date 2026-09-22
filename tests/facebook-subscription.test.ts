import { describe, it, expect } from "vitest";
import { FacebookClient } from "@/modules/channels/facebook/client";
import { FacebookApiError } from "@/modules/channels/facebook/types";

const GRAPH = "https://graph.facebook.com/v21.0";

function clientWith(fetchImpl: typeof fetch) {
  return new FacebookClient({ fetchImpl, graphUrl: GRAPH });
}

describe("FacebookClient page webhook subscription", () => {
  it("subscribePageToApp POSTs to /{page-id}/subscribed_apps with messaging fields and the page token", async () => {
    const calls: { url: string; method: string }[] = [];
    const client = clientWith(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const result = await client.subscribePageToApp("page-token", "page-123");

    expect(result).toEqual({ subscribed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/page-123/subscribed_apps");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("subscribed_fields=messages%2Cmessaging_postbacks");
    expect(calls[0].url).toContain("access_token=page-token");
  });

  it("subscribePageToApp throws FacebookApiError when Graph does not confirm success", async () => {
    const client = clientWith(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
    await expect(client.subscribePageToApp("page-token", "page-123")).rejects.toBeInstanceOf(FacebookApiError);
  });

  it("subscribePageToApp surfaces Graph permission errors as PERMANENT", async () => {
    const client = clientWith(async () =>
      new Response(JSON.stringify({ error: { message: "Requires pages_manage_metadata", code: 10 } }), { status: 200 })
    );
    const err = await client.subscribePageToApp("page-token", "page-123").catch((e) => e);
    expect(err).toBeInstanceOf(FacebookApiError);
    expect(err.kind).toBe("PERMANENT");
    expect(err.code).toBe(10);
  });

  it("getPageSubscriptions GETs the subscription list and exposes app ids + http status", async () => {
    const calls: string[] = [];
    const client = clientWith(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "app-999", name: "Our App" }] }), { status: 200 });
    });

    const result = await client.getPageSubscriptions("page-token", "page-123");

    expect(result.httpStatus).toBe(200);
    expect(result.apps).toEqual([{ id: "app-999", name: "Our App" }]);
    expect(calls[0]).toContain("/page-123/subscribed_apps");
    expect(calls[0]).toContain("fields=id,name");
  });

  it("verification: our app id present in the list means subscribed, absent means not subscribed", async () => {
    const client = clientWith(async () =>
      new Response(JSON.stringify({ data: [{ id: "app-999", name: "Our App" }] }), { status: 200 })
    );
    const subscribedApps = (await client.getPageSubscriptions("page-token", "page-123")).apps;
    expect(subscribedApps.some((a) => a.id === "app-999")).toBe(true);
    expect(subscribedApps.some((a) => a.id === "app-other")).toBe(false);
  });

  it("getPageSubscriptions maps token errors (190) to PERMANENT", async () => {
    const client = clientWith(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }), { status: 200 })
    );
    const err = await client.getPageSubscriptions("bad-token", "page-123").catch((e) => e);
    expect(err).toBeInstanceOf(FacebookApiError);
    expect(err.kind).toBe("PERMANENT");
  });
});