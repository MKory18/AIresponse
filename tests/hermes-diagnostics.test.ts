import { describe, expect, it } from "vitest";
import { runHermesDiagnostics, type HermesDiagDeps } from "@/modules/ai/hermes-diagnostics";

/**
 * Hermes staged diagnostics — every failure must be attributable to its
 * stage (CONFIGURATION / URL_VALIDATION / DNS / CONNECTIVITY / HEALTH /
 * AUTHENTICATION / CHAT_COMPLETION), /health must never prove auth or
 * generation, and the API key must never appear in results.
 */

const SECRET = "diagnostics-secret-key-zz9";
const BASE = "http://127.0.0.1:8642/v1";
const PRIV = { baseUrl: BASE, apiKey: SECRET, model: "hermes-agent", allowPrivateNetwork: true };

const lanDns = async () => [{ address: "192.168.1.10", family: 4 }];
const tcpOk = async () => ({ ok: true as const, latencyMs: 3 });
const tcpRefused = async () => ({ ok: false as const, latencyMs: 1, code: "ECONNREFUSED" });

function fetchStub(handler: (url: string, init: RequestInit) => Promise<Response>): HermesDiagDeps["fetchFn"] {
  return (async (url: string, init: RequestInit) => handler(String(url), init)) as never;
}

const chatOk = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 });
const healthOk = () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });

function stagesOf(r: Awaited<ReturnType<typeof runHermesDiagnostics>>) {
  return Object.fromEntries(r.stages.map((s) => [s.stage, s]));
}

describe("diagnostics configuration stage", () => {
  it("reports missing base URL and touches no network", async () => {
    let calls = 0;
    const count = async () => {
      calls += 1;
      return [];
    };
    const r = await runHermesDiagnostics(
      { baseUrl: "  ", apiKey: SECRET, model: "hermes-agent", allowPrivateNetwork: true },
      { dnsLookupFn: count, tcpDialFn: async () => ({ ok: true as const, latencyMs: 1 }), fetchFn: fetchStub(count as never) }
    );
    expect(r.verdict).toBe("failed");
    expect(r.code).toBe("CONFIG_BASE_URL_MISSING");
    expect(calls).toBe(0);
    expect(r.stages.every((s) => s.stage === "CONFIGURATION" || s.status === "skipped")).toBe(true);
  });

  it("reports a missing key but still checks DNS/TCP/health (network path provable without a key)", async () => {
    const r = await runHermesDiagnostics(
      { baseUrl: BASE, apiKey: " ", model: "hermes-agent", allowPrivateNetwork: true },
      { tcpDialFn: tcpOk, fetchFn: fetchStub(async (url) => (String(url).endsWith("/health") ? healthOk() : chatOk("x"))) }
    );
    const s = stagesOf(r);
    expect(s.CONFIGURATION.detail).toBe("CONFIG_KEY_MISSING");
    expect(s.DNS.status).toBe("pass");
    expect(s.CONNECTIVITY.status).toBe("pass");
    expect(s.AUTHENTICATION.status).toBe("skipped");
    expect(s.CHAT_COMPLETION.status).toBe("skipped");
    expect(r.verdict).toBe("failed");
    expect(r.code).toBe("CONFIG_KEY_MISSING");
  });

  it("sanitizes host/port and flags loopback with a same-namespace note", async () => {
    const r = await runHermesDiagnostics(
      { baseUrl: "http://user:pw@127.0.0.1:8642/v1", apiKey: SECRET, model: "hermes-agent", allowPrivateNetwork: true },
      {}
    );
    // Credentials in URL are rejected before any connection attempt.
    expect(r.code).toMatch(/SSRF_REJECTED_CREDENTIALS_IN_URL/);
    expect(JSON.stringify(r)).not.toContain("user");
    expect(JSON.stringify(r)).not.toContain("pw");
  });
});

describe("diagnostics URL validation shows the actual guard reason", () => {
  it("surfaces SSRF_REJECTED_IP_NOT_GLOBAL_UNICAST without the flag (no generic INVALID_URL)", async () => {
    let network = 0;
    const r = await runHermesDiagnostics(
      { ...PRIV, allowPrivateNetwork: false },
      {
        dnsLookupFn: async () => {
          network += 1;
          return [{ address: "127.0.0.1", family: 4 }];
        },
        tcpDialFn: async () => {
          network += 1;
          return { ok: true as const, latencyMs: 1 };
        },
      }
    );
    expect(r.code).toBe("SSRF_REJECTED_IP_NOT_GLOBAL_UNICAST");
    expect(network).toBe(0);
  });
});

describe("diagnostics DNS stage", () => {
  const HOST_BASE = { baseUrl: "http://hermes:8642/v1", apiKey: SECRET, model: "hermes-agent", allowPrivateNetwork: true };

  it("fails closed on DNS errors with the resolver code", async () => {
    const r = await runHermesDiagnostics(HOST_BASE, {
      dnsLookupFn: async () => {
        throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
      },
    });
    expect(r.code).toBe("DNS_LOOKUP_FAILED_ENOTFOUND");
    expect(stagesOf(r).CONNECTIVITY.status).toBe("skipped");
  });

  it("rejects metadata among resolved addresses even with the flag", async () => {
    const r = await runHermesDiagnostics(HOST_BASE, {
      dnsLookupFn: async () => [
        { address: "192.168.1.10", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });
    expect(r.code).toBe("DNS_POLICY_REJECTED_DNS_NOT_GLOBAL_UNICAST");
  });

  it("displays resolved addresses on success", async () => {
    const r = await runHermesDiagnostics(
      { baseUrl: "http://hermes:8642/v1", apiKey: SECRET, model: "hermes-agent", allowPrivateNetwork: true },
      { dnsLookupFn: lanDns, tcpDialFn: tcpOk, fetchFn: fetchStub(async (url) => (String(url).endsWith("/health") ? healthOk() : chatOk("ok"))) }
    );
    expect(stagesOf(r).DNS.data).toEqual({ addresses: ["192.168.1.10"] });
    expect(r.verdict).toBe("working");
  });
});

describe("diagnostics connectivity stage (Hermes down)", () => {
  it("reports TCP_ECONNREFUSED and never sends HTTP", async () => {
    let http = 0;
    const r = await runHermesDiagnostics(PRIV, {
      tcpDialFn: tcpRefused,
      fetchFn: fetchStub(async () => {
        http += 1;
        return healthOk();
      }),
    });
    expect(r.code).toBe("TCP_ECONNREFUSED");
    expect(http).toBe(0);
    expect(stagesOf(r).HEALTH.status).toBe("skipped");
  });
});

describe("diagnostics authentication vs generation (health proves nothing)", () => {
  const base: HermesDiagDeps = { tcpDialFn: tcpOk };

  it("401 fails AUTH and skips CHAT", async () => {
    const r = await runHermesDiagnostics(PRIV, {
      ...base,
      fetchFn: fetchStub(async (url) => (String(url).endsWith("/health") ? healthOk() : new Response("no", { status: 401 }))),
    });
    const s = stagesOf(r);
    expect(s.AUTHENTICATION).toMatchObject({ status: "fail", detail: "AUTH_HTTP_401" });
    expect(s.CHAT_COMPLETION.status).toBe("skipped");
    expect(r.verdict).toBe("failed");
    expect(r.code).toBe("AUTH_HTTP_401");
  });

  it("a healthy /health with failing chat still fails overall", async () => {
    const r = await runHermesDiagnostics(PRIV, {
      ...base,
      fetchFn: fetchStub(async (url) =>
        String(url).endsWith("/health") ? healthOk() : new Response("err", { status: 500 })
      ),
    });
    const s = stagesOf(r);
    expect(s.HEALTH.status).toBe("pass");
    expect(s.AUTHENTICATION.status).toBe("pass");
    expect(s.CHAT_COMPLETION).toMatchObject({ status: "fail", detail: "CHAT_HTTP_500_TRANSIENT" });
    expect(r.verdict).toBe("failed");
  });

  it("a failing /health with working chat still passes overall (health is informational)", async () => {
    const r = await runHermesDiagnostics(PRIV, {
      ...base,
      fetchFn: fetchStub(async (url) => (String(url).endsWith("/health") ? new Response("x", { status: 404 }) : chatOk("أهلًا"))),
    });
    const s = stagesOf(r);
    expect(s.HEALTH).toMatchObject({ status: "fail", detail: "HEALTH_HTTP_404" });
    expect(s.CHAT_COMPLETION).toMatchObject({ status: "pass", detail: "CHAT_OK" });
    expect(r.verdict).toBe("working");
    expect(r.code).toBe("CHAT_OK");
  });

  it("empty model output fails generation (never a blank success)", async () => {
    const r = await runHermesDiagnostics(PRIV, {
      ...base,
      fetchFn: fetchStub(async (url) => (String(url).endsWith("/health") ? healthOk() : chatOk("   "))),
    });
    expect(stagesOf(r).CHAT_COMPLETION).toMatchObject({ status: "fail", detail: "CHAT_EMPTY_RESPONSE" });
    expect(r.verdict).toBe("failed");
  });

  it("redirects fail fast on both stages", async () => {
    const r = await runHermesDiagnostics(PRIV, {
      ...base,
      fetchFn: fetchStub(async (url) => (String(url).endsWith("/health") ? healthOk() : new Response(null, { status: 307 }))),
    });
    expect(stagesOf(r).AUTHENTICATION.detail).toBe("REDIRECT_BLOCKED");
    expect(stagesOf(r).CHAT_COMPLETION.detail).toBe("REDIRECT_BLOCKED");
    expect(r.verdict).toBe("failed");
  });
});

describe("diagnostics secret hygiene", () => {
  it("the key never appears anywhere in the result — success or failure", async () => {
    const ok = await runHermesDiagnostics(PRIV, {
      tcpDialFn: tcpOk,
      fetchFn: fetchStub(async (url) => (String(url).endsWith("/health") ? healthOk() : chatOk("hi"))),
    });
    expect(JSON.stringify(ok)).not.toContain(SECRET);
    const bad = await runHermesDiagnostics(PRIV, {
      tcpDialFn: tcpRefused,
    });
    expect(JSON.stringify(bad)).not.toContain(SECRET);
    // Sanitized endpoint carries no credentials either.
    expect(ok.endpoint).toBe("http://127.0.0.1:8642/v1/chat/completions");
    expect(ok.host).toBe("127.0.0.1");
    expect(ok.port).toBe(8642);
  });
});
