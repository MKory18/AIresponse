import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  assertHermesEndpointResolves,
  validateHermesEndpoint,
} from "./endpoint-guard";
import { normalizeHermesEndpoint } from "./provider";

/**
 * Hermes staged connectivity diagnostics — the "prove it from inside the
 * app" path for production (Coolify) debugging.
 *
 * Stages (each reported explicitly, never conflated):
 *   CONFIGURATION → URL_VALIDATION → DNS → CONNECTIVITY → HEALTH →
 *   AUTHENTICATION → CHAT_COMPLETION
 *
 * Contract:
 * - /health alone NEVER proves auth or generation (separate stages).
 * - Synthetic traffic only: GET /health (no key) + one POST
 *   /v1/chat/completions {ping, max_tokens 5}. No customer messages, no
 *   order writes, no DB writes.
 * - The API key travels ONLY in the Authorization header of the single
 *   chat POST. It is never copied into results, logs, URLs, or errors.
 * - SSRF policy is enforced, not bypassed: URL_VALIDATION + DNS policy
 *   use the Hermes-scoped guard (loopback/LAN only with the deployer's
 *   HERMES_ALLOW_PRIVATE_NETWORK flag; metadata/reserved always blocked).
 * - Redirects are never followed (manual) — a redirecting gateway fails
 *   fast instead of leaking the key to another host.
 * - HEALTH is informational: it never flips the verdict. The verdict is
 *   "working" only when CONFIGURATION, URL_VALIDATION, DNS, CONNECTIVITY,
 *   AUTHENTICATION and CHAT_COMPLETION all pass.
 */

export type DiagStageName =
  | "CONFIGURATION"
  | "URL_VALIDATION"
  | "DNS"
  | "CONNECTIVITY"
  | "HEALTH"
  | "AUTHENTICATION"
  | "CHAT_COMPLETION";

export type DiagStatus = "pass" | "fail" | "skipped";

export interface DiagStage {
  stage: DiagStageName;
  status: DiagStatus;
  /** Machine-readable code — never contains secrets or customer data. */
  detail: string;
  latencyMs?: number;
  /** Sanitized extras (IPs, ports, status codes). Never credentials. */
  data?: Record<string, unknown>;
}

export interface HermesDiagnostics {
  provider: "hermes";
  verdict: "working" | "failed";
  /** First failing gating-stage code, or CHAT_OK. */
  code: string;
  /** Sanitized full chat URL (credentials stripped) or null. */
  endpoint: string | null;
  host: string | null;
  port: number | null;
  scheme: string | null;
  model: string;
  allowPrivateNetwork: boolean;
  stages: DiagStage[];
}

export interface HermesDiagDeps {
  fetchFn?: typeof fetch;
  dnsLookupFn?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  tcpDialFn?: (host: string, port: number, timeoutMs: number) => Promise<{ ok: true; latencyMs: number } | { ok: false; latencyMs: number; code: string }>;
  tcpTimeoutMs?: number;
  healthTimeoutMs?: number;
  chatTimeoutMs?: number;
}

function defaultPort(scheme: string): number {
  return scheme === "https" ? 443 : 80;
}

/** Keep only [A-Z0-9_] error codes; everything else becomes "ERROR". */
function safeCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)) return code;
  return "ERROR";
}

function tcpDial(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ ok: true; latencyMs: number } | { ok: false; latencyMs: number; code: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (r: { ok: true; latencyMs: number } | { ok: false; latencyMs: number; code: string }) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done({ ok: true, latencyMs: Date.now() - started }));
    sock.once("timeout", () => done({ ok: false, latencyMs: Date.now() - started, code: "TIMEOUT" }));
    sock.once("error", (e) => done({ ok: false, latencyMs: Date.now() - started, code: safeCode(e) }));
  });
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

function isRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400);
}

export async function runHermesDiagnostics(
  input: { baseUrl: string; apiKey: string; model: string; allowPrivateNetwork: boolean },
  deps: HermesDiagDeps = {}
): Promise<HermesDiagnostics> {
  const {
    fetchFn = fetch,
    dnsLookupFn = async (h: string) => {
      const r = await dnsLookup(h, { all: true });
      return r.map((x) => ({ address: x.address, family: x.family }));
    },
    tcpDialFn = tcpDial,
    tcpTimeoutMs = 5000,
    healthTimeoutMs = 5000,
    chatTimeoutMs = 8000,
  } = deps;
  const { baseUrl, apiKey, model, allowPrivateNetwork } = input;
  const stages: DiagStage[] = [];
  const skippedFrom = (stage: DiagStageName, detail: string) => {
    const order: DiagStageName[] = ["CONFIGURATION", "URL_VALIDATION", "DNS", "CONNECTIVITY", "HEALTH", "AUTHENTICATION", "CHAT_COMPLETION"];
    for (const s of order.slice(order.indexOf(stage))) {
      stages.push({ stage: s, status: "skipped", detail });
    }
  };
  const finish = (code: string): HermesDiagnostics => ({
    provider: "hermes",
    verdict: code === "CHAT_OK" ? "working" : "failed",
    code,
    endpoint,
    host,
    port,
    scheme,
    model,
    allowPrivateNetwork,
    stages,
  });

  // ── CONFIGURATION ──────────────────────────────────────────────
  const baseSet = baseUrl.trim().length > 0;
  const keySet = apiKey.trim().length > 0;
  let host: string | null = null;
  let port: number | null = null;
  let scheme: string | null = null;
  let endpoint: string | null = null;
  if (baseSet) {
    try {
      // Sanitize BEFORE anything else: only scheme/host/port survive.
      const normalized = normalizeHermesEndpoint(baseUrl);
      const u = new URL(normalized);
      scheme = u.protocol.replace(":", "");
      host = u.hostname;
      port = u.port ? Number(u.port) : defaultPort(scheme);
      endpoint = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      host = null;
    }
  }
  const loopbackNote =
    host === "localhost" || host === "127.0.0.1" || host === "::1"
      ? "LOOPBACK_NOTE: 127.0.0.1/localhost only works when the gateway shares this container's network namespace (same pod/compose service network)"
      : undefined;
  stages.push({
    stage: "CONFIGURATION",
    status: !baseSet ? "fail" : !keySet ? "fail" : "pass",
    detail: !baseSet ? "CONFIG_BASE_URL_MISSING" : !keySet ? "CONFIG_KEY_MISSING" : "CONFIG_OK",
    data: {
      baseUrlSet: baseSet,
      apiKeySet: keySet,
      model,
      allowPrivateNetwork,
      ...(loopbackNote ? { note: loopbackNote } : {}),
    },
  });
  if (!baseSet) {
    skippedFrom("URL_VALIDATION", "SKIPPED_NO_BASE_URL");
    return finish("CONFIG_BASE_URL_MISSING");
  }

  // ── URL_VALIDATION (actual guard reason, never a generic INVALID_URL) ──
  const urlCheck = validateHermesEndpoint(baseUrl, { allowPrivateNetwork });
  if (!urlCheck.ok) {
    stages.push({ stage: "URL_VALIDATION", status: "fail", detail: `SSRF_REJECTED_${urlCheck.reason}` });
    skippedFrom("DNS", `SKIPPED_URL_REJECTED_${urlCheck.reason}`);
    return finish(`SSRF_REJECTED_${urlCheck.reason}`);
  }
  stages.push({ stage: "URL_VALIDATION", status: "pass", detail: "URL_POLICY_OK" });
  if (!endpoint || !host || port === null || !scheme) {
    skippedFrom("DNS", "SKIPPED_URL_UNPARSEABLE");
    return finish("CONFIG_BASE_URL_INVALID");
  }

  // ── DNS (display addresses, then enforce policy on the SAME set) ──
  const dnsStarted = Date.now();
  let addresses: string[];
  // Literal detection mirrors the guard: IPv6 (colon), dotted hex/octal/dec
  // IPv4, or a bare decimal IPv4 integer. Anything else goes through DNS.
  const hostNoBracket = host.replace(/^\[|\]$/g, "");
  const isLiteral =
    hostNoBracket.includes(":") ||
    (/^[0-9]+$/.test(hostNoBracket) && hostNoBracket.length <= 10) ||
    (hostNoBracket.includes(".") && /^[0-9a-fA-Fx.]+$/.test(hostNoBracket));
  if (isLiteral) {
    // Literal IP: no DNS needed (policy classified it in URL_VALIDATION).
    addresses = [host];
  } else {
    try {
      const resolved = await dnsLookupFn(host);
      addresses = resolved.map((r) => r.address);
    } catch (err) {
      stages.push({
        stage: "DNS",
        status: "fail",
        detail: `DNS_LOOKUP_FAILED_${safeCode(err)}`,
        latencyMs: Date.now() - dnsStarted,
      });
      skippedFrom("CONNECTIVITY", "SKIPPED_DNS_FAILED");
      return finish(`DNS_LOOKUP_FAILED_${safeCode(err)}`);
    }
    if (addresses.length === 0) {
      stages.push({ stage: "DNS", status: "fail", detail: "DNS_NO_ADDRESSES", latencyMs: Date.now() - dnsStarted });
      skippedFrom("CONNECTIVITY", "SKIPPED_DNS_FAILED");
      return finish("DNS_NO_ADDRESSES");
    }
  }
  // Policy check against the exact addresses we will report.
  const policy = await assertHermesEndpointResolves(endpoint, {
    allowPrivateNetwork,
    lookupFn: async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  });
  if (!policy.ok) {
    stages.push({
      stage: "DNS",
      status: "fail",
      detail: `DNS_POLICY_REJECTED_${policy.reason}`,
      latencyMs: Date.now() - dnsStarted,
      data: { addresses },
    });
    skippedFrom("CONNECTIVITY", `SKIPPED_DNS_POLICY_${policy.reason}`);
    return finish(`DNS_POLICY_REJECTED_${policy.reason}`);
  }
  stages.push({ stage: "DNS", status: "pass", detail: "DNS_OK", latencyMs: Date.now() - dnsStarted, data: { addresses } });

  // ── CONNECTIVITY (TCP dial — proves L3/L4 before any HTTP) ──
  const dial = await tcpDialFn(host, port, tcpTimeoutMs);
  if (!dial.ok) {
    stages.push({ stage: "CONNECTIVITY", status: "fail", detail: `TCP_${dial.code}`, latencyMs: dial.latencyMs, data: { host, port } });
    skippedFrom("HEALTH", "SKIPPED_TCP_FAILED");
    return finish(`TCP_${dial.code}`);
  }
  stages.push({ stage: "CONNECTIVITY", status: "pass", detail: "TCP_OK", latencyMs: dial.latencyMs, data: { host, port } });

  // ── HEALTH (informational only — never flips the verdict) ──
  const healthUrl = `${scheme}://${host}:${port}/health`;
  const healthStarted = Date.now();
  try {
    const hres = await fetchWithTimeout(fetchFn, healthUrl, { method: "GET" }, healthTimeoutMs);
    if (isRedirect(hres)) {
      stages.push({ stage: "HEALTH", status: "fail", detail: "HEALTH_REDIRECT_BLOCKED", latencyMs: Date.now() - healthStarted });
    } else {
      stages.push({
        stage: "HEALTH",
        status: hres.ok ? "pass" : "fail",
        detail: `HEALTH_HTTP_${hres.status}`,
        latencyMs: Date.now() - healthStarted,
      });
    }
  } catch (err) {
    const d = err instanceof Error && err.name === "AbortError" ? "HEALTH_TIMEOUT" : `HEALTH_NETWORK_ERROR_${safeCode(err)}`;
    stages.push({ stage: "HEALTH", status: "fail", detail: d, latencyMs: Date.now() - healthStarted });
  }

  // ── AUTHENTICATION + CHAT_COMPLETION (single synthetic POST) ──
  if (!keySet) {
    stages.push({ stage: "AUTHENTICATION", status: "skipped", detail: "SKIPPED_NO_KEY" });
    stages.push({ stage: "CHAT_COMPLETION", status: "skipped", detail: "SKIPPED_NO_KEY" });
    return finish("CONFIG_KEY_MISSING");
  }
  const chatStarted = Date.now();
  let cres: Response;
  try {
    cres = await fetchWithTimeout(
      fetchFn,
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
      },
      chatTimeoutMs
    );
  } catch (err) {
    const d = err instanceof Error && err.name === "AbortError" ? "CHAT_TIMEOUT" : `CHAT_NETWORK_ERROR_${safeCode(err)}`;
    stages.push({ stage: "AUTHENTICATION", status: "fail", detail: d, latencyMs: Date.now() - chatStarted });
    stages.push({ stage: "CHAT_COMPLETION", status: "fail", detail: d, latencyMs: Date.now() - chatStarted });
    return finish(d);
  }
  if (isRedirect(cres)) {
    stages.push({ stage: "AUTHENTICATION", status: "fail", detail: "REDIRECT_BLOCKED", latencyMs: Date.now() - chatStarted });
    stages.push({ stage: "CHAT_COMPLETION", status: "fail", detail: "REDIRECT_BLOCKED", latencyMs: Date.now() - chatStarted });
    return finish("REDIRECT_BLOCKED");
  }
  if (cres.status === 401 || cres.status === 403) {
    stages.push({ stage: "AUTHENTICATION", status: "fail", detail: `AUTH_HTTP_${cres.status}`, latencyMs: Date.now() - chatStarted });
    stages.push({ stage: "CHAT_COMPLETION", status: "skipped", detail: "SKIPPED_AUTH_FAILED" });
    return finish(`AUTH_HTTP_${cres.status}`);
  }
  // Any other answered status means the credentialed request engaged the
  // gateway (no auth rejection observed).
  stages.push({ stage: "AUTHENTICATION", status: "pass", detail: `AUTH_HTTP_${cres.status}`, latencyMs: Date.now() - chatStarted });
  if (cres.status !== 200) {
    const transient = cres.status === 429 || cres.status >= 500;
    const d = `CHAT_HTTP_${cres.status}${transient ? "_TRANSIENT" : ""}`;
    stages.push({ stage: "CHAT_COMPLETION", status: "fail", detail: d, latencyMs: Date.now() - chatStarted });
    return finish(d);
  }
  try {
    const json = (await cres.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      stages.push({ stage: "CHAT_COMPLETION", status: "fail", detail: "CHAT_EMPTY_RESPONSE", latencyMs: Date.now() - chatStarted });
      return finish("CHAT_EMPTY_RESPONSE");
    }
    stages.push({
      stage: "CHAT_COMPLETION",
      status: "pass",
      detail: "CHAT_OK",
      latencyMs: Date.now() - chatStarted,
      data: { contentLength: content.length },
    });
    return finish("CHAT_OK");
  } catch {
    stages.push({ stage: "CHAT_COMPLETION", status: "fail", detail: "CHAT_INVALID_RESPONSE", latencyMs: Date.now() - chatStarted });
    return finish("CHAT_INVALID_RESPONSE");
  }
}
