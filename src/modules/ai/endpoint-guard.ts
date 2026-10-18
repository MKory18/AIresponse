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

/** يوسّع IPv6 لثمان مجموعات 16 بت (يدعم «::» والذيل العشري a.b.c.d). */
function expandIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  const dotted = h.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const parts = dotted[2].split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    h = `${dotted[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * IPv4 مضمّن بعنوان IPv6 — المحلّل (WHATWG URL) بيكتب ::ffff:127.0.0.1
 * بالشكل الست عشري ::ffff:7f00:1، فالفحص بالشكل العشري لحاله كان بيفوّته:
 * mapped (::ffff:a.b.c.d) · translated (::ffff:0:a.b.c.d) · 6to4 (2002:AABB:CCDD::).
 * compatible (::a.b.c.d — مهجور) = محجوب دايمًا.
 */
function embeddedIPv4(g: number[]): { v4: number[]; alwaysBlocked: boolean } | null {
  const tail = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return { v4: tail(g[6], g[7]), alwaysBlocked: false };
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return { v4: tail(g[6], g[7]), alwaysBlocked: false };
  if (zero(0, 6)) return { v4: tail(g[6], g[7]), alwaysBlocked: true };
  if (g[0] === 0x2002) return { v4: tail(g[1], g[2]), alwaysBlocked: false };
  return null;
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
  // P12: نفس الفحص بكل أشكال IPv4 المضمّن (ست عشري · translated · 6to4).
  const groups = expandIPv6(low);
  if (!groups) return true; // شكل غير مفهوم = محجوب (fail-closed)
  const embedded = embeddedIPv4(groups);
  if (embedded) return embedded.alwaysBlocked || ipv4Blocked(embedded.v4);
  if (low.startsWith("fe80:")) return true; // link-local
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
  if (low.startsWith("ff")) return true; // multicast
  if (low.startsWith("2001:db8")) return true; // documentation
  if (low === "100::" || low.startsWith("64:ff9b:")) return true; // special-use/translation
  return false;
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
