import { describe, expect, it } from "vitest";
import {
  validateEndpointUrl,
  assertEndpointResolvesPublic,
  validateHermesEndpoint,
  assertHermesEndpointResolves,
  isHermesPrivateNetworkAllowed,
} from "@/modules/ai/endpoint-guard";
import { OpenAICompatibleProvider, probeProviderEndpoint, AIProviderError } from "@/modules/ai/provider";

/**
 * Hermes INVALID_URL fix — the scoped private-network exception.
 *
 * Pins: (1) the strict guard still rejects loopback/LAN/metadata (other
 * providers byte-identical), (2) Hermes + HERMES_ALLOW_PRIVATE_NETWORK
 * additionally allows loopback/RFC1918/localhost only, (3) metadata,
 * link-local 169.254/16, credentials, and reserved ranges stay blocked
 * with or without the flag, (4) DNS-layer verification of the final
 * addresses, (5) redirects never followed on the Hermes path.
 */

const PRIV = { allowPrivateNetwork: true };
const STRICT = { allowPrivateNetwork: false };

describe("strict guard unchanged (other providers unaffected)", () => {
  it("rejects loopback, LAN, metadata, and reserved literals", () => {
    for (const u of [
      "http://127.0.0.1:8642/v1",
      "http://localhost:8642/v1",
      "http://10.0.0.9:8642/v1",
      "http://172.20.5.4:8642/v1",
      "http://192.168.1.20:8642/v1",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
      "http://[::1]:8642/v1",
      "http://0.0.0.0:8642/v1",
      "http://224.0.0.1:8642/v1",
    ]) {
      expect(validateEndpointUrl(u).ok, u).toBe(false);
    }
  });

  it("rejects credentials, bad schemes, and malformed URLs", () => {
    expect(validateEndpointUrl("http://user:pass@93.184.216.34/v1").ok).toBe(false);
    expect(validateEndpointUrl("ftp://93.184.216.34/v1").ok).toBe(false);
    expect(validateEndpointUrl("93.184.216.34:8642").ok).toBe(false);
    expect(validateEndpointUrl("not a url").ok).toBe(false);
  });

  it("still accepts public endpoints", () => {
    expect(validateEndpointUrl("https://hermes.example.com/v1/chat/completions").ok).toBe(true);
  });
});

describe("Hermes validator without the flag ≡ strict", () => {
  it("rejects the local Hermes gateway exactly like before", () => {
    expect(validateHermesEndpoint("http://127.0.0.1:8642/v1", STRICT)).toEqual(
      validateEndpointUrl("http://127.0.0.1:8642/v1")
    );
    expect(validateHermesEndpoint("http://127.0.0.1:8642/v1", STRICT).ok).toBe(false);
    expect(validateHermesEndpoint("http://localhost:8642/v1", STRICT).ok).toBe(false);
    expect(validateHermesEndpoint("http://192.168.1.20:8642/v1", STRICT).ok).toBe(false);
  });
});

describe("Hermes validator with HERMES_ALLOW_PRIVATE_NETWORK", () => {
  it("allows loopback / localhost / RFC1918 Hermes addresses", () => {
    for (const u of [
      "http://127.0.0.1:8642/v1",
      "http://127.0.0.1:8642/v1/chat/completions",
      "http://localhost:8642/v1",
      "http://192.168.1.20:8642/v1",
      "http://10.0.0.9:8642/v1",
      "http://172.20.5.4:8642/v1",
      "https://192.168.1.20:8642/v1",
      // Obfuscated loopback literal is canonicalized before classification.
      "http://2130706433:8642/v1",
      "http://[::1]:8642/v1",
    ]) {
      expect(validateHermesEndpoint(u, PRIV), u).toEqual({ ok: true });
    }
  });

  it("still blocks metadata, link-local, credentials, and reserved — flag or not", () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/", // cloud metadata IP
      "http://metadata.google.internal/",
      "http://instance-data/computeMetadata/",
      "http://0.0.0.0:8642/v1",
      "http://224.0.0.1:8642/v1",
      "http://100.64.0.1:8642/v1", // CGNAT shared space
      "http://admin:secret@127.0.0.1:8642/v1", // credentials smuggled with loopback
      "ftp://192.168.1.20/v1",
      "192.168.1.20:8642",
      "http://hermes.lan:8642/v1", // ambient internal namespace stays blocked
    ]) {
      const r = validateHermesEndpoint(u, PRIV);
      expect(r.ok, u).toBe(false);
    }
  });

  it("keeps accepting public endpoints under the flag", () => {
    expect(validateHermesEndpoint("https://hermes.example.com/v1", PRIV)).toEqual({ ok: true });
  });
});

describe("Hermes DNS layer verifies final addresses", () => {
  const lan = async () => [{ address: "192.168.1.10", family: 4 }];
  const loop = async () => [{ address: "127.0.0.1", family: 4 }];
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  const mixedMeta = async () => [
    { address: "192.168.1.10", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ];
  const failing = async (): Promise<Array<{ address: string; family: number }>> => {
    throw new Error("dns down");
  };

  it("allows hostnames resolving to LAN/loopback only with the flag", async () => {
    expect(await assertHermesEndpointResolves("http://hermes:8642/v1", { ...PRIV, lookupFn: lan })).toEqual({
      ok: true,
    });
    expect(await assertHermesEndpointResolves("http://hermes:8642/v1", { ...PRIV, lookupFn: loop })).toEqual({
      ok: true,
    });
    expect((await assertHermesEndpointResolves("http://hermes:8642/v1", { ...STRICT, lookupFn: lan })).ok).toBe(false);
  });

  it("allows public resolutions with or without the flag", async () => {
    expect(await assertHermesEndpointResolves("http://hermes.example.com/v1", { lookupFn: pub })).toEqual({
      ok: true,
    });
    expect(await assertHermesEndpointResolves("http://hermes.example.com/v1", { ...PRIV, lookupFn: pub })).toEqual({
      ok: true,
    });
  });

  it("rejects when ANY resolved address is metadata — even with the flag", async () => {
    const r = await assertHermesEndpointResolves("http://hermes:8642/v1", { ...PRIV, lookupFn: mixedMeta });
    expect(r).toEqual({ ok: false, reason: "DNS_NOT_GLOBAL_UNICAST" });
  });

  it("fails closed on DNS errors and empty answers", async () => {
    expect(await assertHermesEndpointResolves("http://hermes:8642/v1", { ...PRIV, lookupFn: failing })).toEqual({
      ok: false,
      reason: "DNS_RESOLUTION_FAILED",
    });
    expect(await assertHermesEndpointResolves("http://hermes:8642/v1", { ...PRIV, lookupFn: async () => [] })).toEqual({
      ok: false,
      reason: "DNS_RESOLUTION_FAILED",
    });
  });

  it("strict DNS helper still rejects LAN (other providers unchanged)", async () => {
    expect(await assertEndpointResolvesPublic("http://hermes:8642/v1", lan)).toEqual({
      ok: false,
      reason: "DNS_NOT_GLOBAL_UNICAST",
    });
  });
});

describe("HERMES_ALLOW_PRIVATE_NETWORK parsing (server env only)", () => {
  it("enables on 1/true/yes (case-insensitive), disables otherwise", () => {
    expect(isHermesPrivateNetworkAllowed({ HERMES_ALLOW_PRIVATE_NETWORK: "1" })).toBe(true);
    expect(isHermesPrivateNetworkAllowed({ HERMES_ALLOW_PRIVATE_NETWORK: "true" })).toBe(true);
    expect(isHermesPrivateNetworkAllowed({ HERMES_ALLOW_PRIVATE_NETWORK: "YES" })).toBe(true);
    expect(isHermesPrivateNetworkAllowed({})).toBe(false);
    expect(isHermesPrivateNetworkAllowed({ HERMES_ALLOW_PRIVATE_NETWORK: "0" })).toBe(false);
    expect(isHermesPrivateNetworkAllowed({ HERMES_ALLOW_PRIVATE_NETWORK: "false" })).toBe(false);
    expect(isHermesPrivateNetworkAllowed({ HERMES_ALLOW_PRIVATE_NETWORK: "" })).toBe(false);
  });
});

describe("Hermes never follows redirects (key + prompts stay put)", () => {
  function hermesNoRedirect() {
    return new OpenAICompatibleProvider({
      name: "hermes",
      apiKey: "k",
      baseUrl: "http://127.0.0.1:8642/v1/chat/completions",
      defaultModel: "hermes-agent",
      followRedirects: false,
    });
  }

  it("chat fails fast (non-retryable) on a redirecting gateway", async () => {
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => new Response(null, { status: 307 });
    try {
      const err = await hermesNoRedirect().generateText({ system: "s", user: "u" }).catch((e) => e);
      expect(err).toBeInstanceOf(AIProviderError);
      expect(String(err.message)).toMatch(/REDIRECT_BLOCKED/);
      expect(err.retryable).toBe(false);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = orig;
    }
  });

  it("default providers keep following redirects (behavior unchanged)", async () => {
    const orig = globalThis.fetch;
    let seenRedirect: RequestRedirect | undefined;
    (globalThis as { fetch: unknown }).fetch = async (_url: string, init: RequestInit) => {
      seenRedirect = init.redirect;
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: {} }), { status: 200 });
    };
    try {
      const p = new OpenAICompatibleProvider({
        name: "openai",
        apiKey: "k",
        baseUrl: "https://api.openai.com/v1/chat/completions",
        defaultModel: "m",
      });
      await p.generateText({ system: "s", user: "u" });
      expect(seenRedirect).toBe("follow");
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = orig;
    }
  });

  it("probe reports REDIRECT_BLOCKED with redirects disabled", async () => {
    const r = await probeProviderEndpoint("http://127.0.0.1:8642/v1/chat/completions", "k", "hermes-agent", {
      fetchFn: (async () => new Response(null, { status: 307 })) as never,
      followRedirects: false,
    });
    expect(r).toEqual({ ok: false, latencyMs: expect.any(Number), detail: "REDIRECT_BLOCKED" });
  });
});
