import { lookup } from "node:dns/promises";

/**
 * P7 — SSRF guard for operator-configured model endpoints (`customBaseUrl`).
 *
 * Threat: any workspace user with `ai.configure` can store an endpoint URL
 * that the SERVER later fetches (connection probe + every AI call resolved
 * to the internal provider). Without validation that URL could target
 * loopback services, cloud metadata endpoints, or other tenants'
 * infrastructure — and AI prompts (customer PII) would be sent there.
 *
 * Policy (fail-closed, narrowest safe scope):
 * - Only http/https, no embedded credentials, no explicit port tricks beyond
 *   the URL itself (ports are allowed — self-hosted endpoints need them).
 * - The host must resolve to a GLOBAL UNICAST address. Rejected: loopback,
 *   private LAN (RFC1918/ULA), link-local, unspecified, multicast, reserved,
 *   plus well-known metadata hostnames. This means LAN-only endpoints
 *   (e.g. http://192.168.x.x:11434) are BLOCKED by policy: a self-hosted
 *   model must be exposed at a global address so the trust boundary is
 *   explicit and auditable. Documented in SECURITY-AUDIT.md §P7.
 * - Validation is two-layer: synchronous literal/hostname checks run on
 *   EVERY use (save path, probe path, provider resolution); DNS resolution
 *   re-checks run on the save and probe paths (TOCTOU/DNS-rebinding
 *   mitigation — best effort, documented as such).
 */

export type EndpointRejection =
  | "INVALID_URL"
  | "SCHEME_NOT_ALLOWED"
  | "CREDENTIALS_IN_URL"
  | "HOST_BLOCKED"
  | "IP_NOT_GLOBAL_UNICAST"
  | "DNS_RESOLUTION_FAILED"
  | "DNS_NOT_GLOBAL_UNICAST";

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
  "instance-data.compute.internal",
]);

function isDecimalDigits(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

/** Normalize obfuscated IPv4 literals (decimal/octal/hex per-part). */
function normalizeIPv4(host: string): number[] | null {
  const raw = host.endsWith(".") ? host.slice(0, -1) : host;
  // Single-number form (e.g. 2130706433 == 127.0.0.1).
  if (isDecimalDigits(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  const parts = raw.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p.length === 0) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p) && p.length > 1) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    nums.push(n);
  }
  // Last part may hold multiple octets (e.g. 127.1 == 127.0.0.1).
  if (nums.some((n) => n > 255) && parts.length !== 4) {
    const last = nums.pop()!;
    const need = 4 - nums.length;
    if (last >= 256 ** need) return null;
    for (let i = need - 1; i >= 0; i--) nums.push(Math.floor(last / 256 ** i) % 256);
  }
  if (nums.some((n) => n > 255)) return null;
  while (nums.length < 4) {
    // Expand short forms: a.b.c -> a.b.0.c ; a.b -> a.0.0.b
    if (nums.length === 3) nums.splice(2, 0, 0);
    else if (nums.length === 2) nums.splice(1, 0, 0, 0);
    else return null;
  }
  return nums;
}

function ipv4Blocked(o: number[]): boolean {
  const [a, b] = o;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // unspecified / software scope
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved (incl. 255.255.255.255)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared
  if (a === 192 && (b === 0 || b === 2 || b === 88 || b === 31)) return true; // special-use
  if (a === 203 && b === 0) return true; // documentation TEST-NET-3 (192.0.2/24 handled above; 198.51.100/24, 203.0.113/24)
  if (a === 198 && (b === 51 || b === 18)) return true; // documentation/benchmarking
  return false;
}

function ipv6Blocked(host: string): boolean {
  // host arrives without brackets, lowercased, zone id stripped.
  if (host === "::1" || host === "::") return true;
  if (host === "::ffff:127.0.0.1") return true;
  const low = host.toLowerCase();
  // IPv4-mapped: ::ffff:a.b.c.d — check the embedded v4.
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = normalizeIPv4(mapped[1]);
    return !v4 || ipv4Blocked(v4);
  }
  if (low.startsWith("fe80:")) return true; // link-local
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
  if (low.startsWith("ff")) return true; // multicast
  if (low.startsWith("2001:db8")) return true; // documentation
  if (low === "100::" || low.startsWith("64:ff9b:")) return true; // special-use/translation
  return false;
}

/** Loopback only (127.0.0.0/8) — the narrowest private allowance. */
function isLoopbackIPv4(o: number[]): boolean {
  return o[0] === 127;
}

/** RFC1918 private LAN (10/8, 172.16/12, 192.168/16) — no link-local. */
function isRfc1918IPv4(o: number[]): boolean {
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function hostnameBlocked(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h === "localhost.localdomain") return true;
  if (h.endsWith(".local")) return true; // mDNS — link-local by definition
  if (h.endsWith(".internal") || h.endsWith(".corp") || h.endsWith(".lan") || h.endsWith(".home")) return true;
  if (METADATA_HOSTS.has(h)) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

/** Synchronous checks: literals, obfuscation, well-known names. */
export function validateEndpointUrl(raw: string): { ok: true } | { ok: false; reason: EndpointRejection } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "SCHEME_NOT_ALLOWED" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "CREDENTIALS_IN_URL" };
  }
  let host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "INVALID_URL" };
  // Strip IPv6 brackets + zone id.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.split("%")[0];
  if (hostnameBlocked(host)) return { ok: false, reason: "HOST_BLOCKED" };
  if (host.includes(":")) {
    if (ipv6Blocked(host)) return { ok: false, reason: "IP_NOT_GLOBAL_UNICAST" };
    return { ok: true };
  }
  const v4 = normalizeIPv4(host);
  if (v4) {
    if (ipv4Blocked(v4)) return { ok: false, reason: "IP_NOT_GLOBAL_UNICAST" };
    return { ok: true };
  }
  // Non-literal hostname: sync pass only (DNS layer re-checks async).
  if (/[^a-z0-9.-]/.test(host) || host.length > 253) return { ok: false, reason: "INVALID_URL" };
  return { ok: true };
}

/** Async DNS layer: every resolved address must be global unicast. */
export async function assertEndpointResolvesPublic(
  raw: string,
  lookup: (host: string) => Promise<Array<{ address: string; family: number }>> = (h) =>
    lookup(h).then((r) => r.map((x) => ({ address: x.address, family: x.family })))
): Promise<{ ok: true } | { ok: false; reason: EndpointRejection }> {
  const sync = validateEndpointUrl(raw);
  if (!sync.ok) return sync;
  const host = new URL(raw.trim()).hostname;
  // Literal IPs need no DNS (already classified above).
  if (normalizeIPv4(host.toLowerCase()) || host.includes(":")) return { ok: true };
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host);
  } catch {
    return { ok: false, reason: "DNS_RESOLUTION_FAILED" };
  }
  if (addrs.length === 0) return { ok: false, reason: "DNS_RESOLUTION_FAILED" };
  for (const a of addrs) {
    const addr = a.address.toLowerCase();
    if (a.family === 6 || addr.includes(":")) {
      if (ipv6Blocked(addr.split("%")[0])) return { ok: false, reason: "DNS_NOT_GLOBAL_UNICAST" };
    } else {
      const v4 = normalizeIPv4(addr);
      if (!v4 || ipv4Blocked(v4)) return { ok: false, reason: "DNS_NOT_GLOBAL_UNICAST" };
    }
  }
  return { ok: true };
}

// ── Hermes-scoped private-network exception ─────────────────────────────
// A self-hosted Hermes gateway typically listens on loopback/LAN
// (e.g. http://127.0.0.1:8642), which the strict guard above rejects by
// design. This exception is NARROW and deployer-opt-in:
//
// - Enabled ONLY via server-side `HERMES_ALLOW_PRIVATE_NETWORK=1/true/yes`
//   (never from workspace UI input — the UI only supplies the URL).
// - Applies ONLY to provider "hermes" call sites (settings save + probe).
//   Every other provider keeps the strict guard, byte-identical.
// - Additionally allowed (beyond strict): IPv4 loopback 127/8, RFC1918 LAN
//   (10/8, 172.16/12, 192.168/16 — obfuscated literals included, since
//   normalizeIPv4 canonicalizes them first), the `localhost` hostname, and
//   IPv6 `::1`.
// - ALWAYS blocked, flag or not: cloud metadata hostnames/IPs (notably
//   169.254.169.254, which lives in link-local 169.254/16 — kept blocked),
//   0.0.0.0/::, multicast, reserved, CGNAT, ULA, embedded credentials,
//   non-http(s) schemes, and malformed URLs.

export interface HermesEndpointOpts {
  allowPrivateNetwork?: boolean;
}

function parseHermesHost(raw: string):
  | { ok: true; url: URL; host: string }
  | { ok: false; reason: EndpointRejection } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "SCHEME_NOT_ALLOWED" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "CREDENTIALS_IN_URL" };
  }
  let host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "INVALID_URL" };
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.split("%")[0];
  // Metadata namespaces are never Hermes targets, flag or not.
  if (
    METADATA_HOSTS.has(host) ||
    host === "metadata.google.internal" ||
    host === "localhost.localdomain"
  ) {
    return { ok: false, reason: "HOST_BLOCKED" };
  }
  return { ok: true, url, host };
}

/** Hermes sync checks: strict baseline + optional loopback/RFC1918. */
export function validateHermesEndpoint(
  raw: string,
  opts: HermesEndpointOpts = {}
): { ok: true } | { ok: false; reason: EndpointRejection } {
  const parsed = parseHermesHost(raw);
  if (!parsed.ok) return parsed;
  const { host } = parsed;
  if (!opts.allowPrivateNetwork) return validateEndpointUrl(raw);
  // Private allowance (narrow): localhost name, loopback, RFC1918.
  if (host === "localhost") return { ok: true };
  if (host === "::1") return { ok: true };
  const v4 = normalizeIPv4(host);
  if (v4) {
    if (isLoopbackIPv4(v4) || isRfc1918IPv4(v4)) return { ok: true };
    // Anything else literal (incl. 169.254.x metadata, 0.0.0.0, multicast,
    // reserved, CGNAT) falls through to the strict classifier below.
  } else if (host.includes(":")) {
    // IPv6: only ::1 is additionally allowed; ULA/link-local stay blocked.
    if (host !== "::1") {
      if (ipv6Blocked(host)) return { ok: false, reason: "IP_NOT_GLOBAL_UNICAST" };
      return { ok: true };
    }
    return { ok: true };
  }
  // Non-literal hostnames (.lan/.local etc. stay blocked like strict) and
  // all remaining literals: strict verdict decides.
  return validateEndpointUrl(raw);
}

function dnsAddrAllowed(
  address: string,
  family: number,
  allowPrivateNetwork: boolean
): boolean {
  const addr = address.toLowerCase().split("%")[0];
  if (family === 6 || addr.includes(":")) {
    if (addr === "::1") return allowPrivateNetwork;
    return !ipv6Blocked(addr);
  }
  const v4 = normalizeIPv4(addr);
  if (!v4) return false;
  if (!ipv4Blocked(v4)) return true; // global unicast
  // Blocked-literal that is still acceptable for Hermes iff explicitly
  // loopback/RFC1918 under the flag. 169.254/16 (metadata), 0.0.0.0,
  // multicast, reserved and CGNAT never pass, flag or not.
  return allowPrivateNetwork && (isLoopbackIPv4(v4) || isRfc1918IPv4(v4));
}

/** Hermes DNS layer: every resolved address must be allowed (see above). */
export async function assertHermesEndpointResolves(
  raw: string,
  opts: HermesEndpointOpts & {
    lookupFn?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  } = {}
): Promise<{ ok: true } | { ok: false; reason: EndpointRejection }> {
  const { lookupFn = async (h: string) => {
    const resolved = await lookup(h, { all: true });
    return resolved.map((x) => ({ address: x.address, family: x.family }));
  }, allowPrivateNetwork = false } = opts;
  const sync = validateHermesEndpoint(raw, { allowPrivateNetwork });
  if (!sync.ok) return sync;
  const parsed = parseHermesHost(raw);
  if (!parsed.ok) return parsed;
  // Literal IPs need no DNS (already classified above).
  if (normalizeIPv4(parsed.host) || parsed.host.includes(":")) return { ok: true };
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookupFn(parsed.host);
  } catch {
    return { ok: false, reason: "DNS_RESOLUTION_FAILED" };
  }
  if (addrs.length === 0) return { ok: false, reason: "DNS_RESOLUTION_FAILED" };
  for (const a of addrs) {
    if (!dnsAddrAllowed(a.address, a.family, allowPrivateNetwork)) {
      return { ok: false, reason: "DNS_NOT_GLOBAL_UNICAST" };
    }
  }
  return { ok: true };
}

/**
 * Trusted server-side toggle for the Hermes private exception. Reads ONLY
 * the deployer's environment (never workspace input): "1"/"true"/"yes"
 * (case-insensitive) enables; anything else (incl. unset) disables.
 */
export function isHermesPrivateNetworkAllowed(
  env: Record<string, string | undefined> = process.env
): boolean {
  return ["1", "true", "yes"].includes((env.HERMES_ALLOW_PRIVATE_NETWORK ?? "").toLowerCase());
}
