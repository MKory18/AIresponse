import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, resolveRedirectUri } from "@/modules/channels/facebook/oauth";

const REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
];

function scopesOf(url: string): string[] {
  return new URLSearchParams(url.split("?")[1]).get("scope")!.split(",");
}

describe("Facebook OAuth authorize URL", () => {
  it("requests all required page scopes including pages_read_engagement", () => {
    const url = buildAuthorizeUrl("state-token", "https://staging.example.com/api/channels/facebook/callback");
    const scopes = scopesOf(url);
    for (const s of REQUIRED_SCOPES) {
      expect(scopes).toContain(s);
    }
  });

  it("targets the Meta OAuth dialog with code response_type and state", () => {
    const url = buildAuthorizeUrl("state-token", "https://staging.example.com/api/channels/facebook/callback");
    expect(url).toMatch(/^https:\/\/www\.facebook\.com\/v\d+\.\d+\/dialog\/oauth\?/);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("state")).toBe("state-token");
    expect(params.get("redirect_uri")).toBe("https://staging.example.com/api/channels/facebook/callback");
  });

  it("keeps webhook-independent defaults for the redirect URI", () => {
    expect(resolveRedirectUri("https://staging.example.com")).toBe(
      "https://staging.example.com/api/channels/facebook/callback"
    );
  });
});
